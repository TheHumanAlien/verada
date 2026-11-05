// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";

/// @title EpochGovernor
/// @notice Weekly epochs in which holders pick the cause that receives a token's cause pool.
/// @dev The governor owns eligibility and weights; the pluggable `IVotingScheme` owns the ballots
///      and the tally. An epoch is a poll keyed `(this, token, epoch)` on the scheme it was opened
///      with, so swapping the scheme only affects epochs opened afterwards. Weights are the
///      token's vote checkpoints at `snapshotOf(epoch)` in whole tokens.
contract EpochGovernor is IEpochGovernor, IBallotGovernor, Ownable2Step {
    /// @inheritdoc IEpochGovernor
    uint256 public constant EPOCH_LENGTH = 7 days;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MAX_OPTIONS = 10;

    /// @inheritdoc IEpochGovernor
    uint256 public immutable epochZeroStart;

    /// @notice Cause registry used to check that shortlisted causes are active.
    ICauseRegistry public immutable registry;

    /// @notice Profile registry naming the controller allowed to set a token's shortlist.
    ITokenProfileRegistry public immutable profileRegistry;

    /// @notice Factory allowed to register tokens (set once by the owner).
    address public factory;

    /// @inheritdoc IEpochGovernor
    bytes32 public defaultCause;

    IVotingScheme private _scheme;
    bytes32[] private _defaultShortlist;

    struct EpochState {
        bool opened;
        bool closed;
        bool finalized;
        IVotingScheme scheme;
        bytes32 winner;
        uint256 voters;
        bytes32[] options;
        mapping(address voter => bool) voted;
    }

    mapping(address token => bool) public isRegistered;
    mapping(address token => bytes32[]) private _shortlists;
    mapping(address token => mapping(uint256 epoch => EpochState)) private _epochs;
    mapping(address token => mapping(uint256 epoch => mapping(bytes32 causeId => uint256))) private
        _tally;

    /// @param initialOwner Admin allowed to set the factory once, swap the scheme and curate the
    ///        default shortlist and fallback cause.
    /// @param registry_ Cause registry.
    /// @param scheme_ Initial voting scheme.
    /// @param profileRegistry_ Token profile registry (shortlist authority).
    constructor(
        address initialOwner,
        ICauseRegistry registry_,
        IVotingScheme scheme_,
        ITokenProfileRegistry profileRegistry_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || address(scheme_) == address(0)
                || address(profileRegistry_) == address(0)
        ) revert ZeroAddress();
        registry = registry_;
        _scheme = scheme_;
        profileRegistry = profileRegistry_;
        // Align epoch 0 to the Thursday 00:00 UTC at or before deployment (unix time 0 was a
        // Thursday), so the first epoch may be shorter than a full week.
        // forge-lint: disable-next-line(divide-before-multiply)
        epochZeroStart = (block.timestamp / EPOCH_LENGTH) * EPOCH_LENGTH;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the factory. Can only be done once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Replaces the voting scheme for epochs opened from now on. Epochs already opened
    ///         keep the scheme they were opened with.
    function setScheme(IVotingScheme scheme_) external onlyOwner {
        if (address(scheme_) == address(0)) revert ZeroAddress();
        _scheme = scheme_;
        emit SchemeUpdated(address(scheme_));
    }

    /// @notice Sets the fallback cause paid when an epoch ends with no ballots, so its funds are
    ///         never stranded. Zero clears the fallback; otherwise the cause must be active.
    function setDefaultCause(bytes32 causeId) external onlyOwner {
        if (causeId != bytes32(0) && !registry.isActive(causeId)) revert InactiveCause(causeId);
        defaultCause = causeId;
        emit DefaultCauseSet(causeId);
    }

    /// @inheritdoc IEpochGovernor
    function setDefaultShortlist(bytes32[] calldata causes) external onlyOwner {
        _validateShortlist(causes);
        _defaultShortlist = causes;
        emit DefaultShortlistSet(causes);
    }

    /// @inheritdoc IEpochGovernor
    function setShortlist(address token, bytes32[] calldata causes) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
        if (causes.length != 0) _validateShortlist(causes);
        _shortlists[token] = causes;
        emit ShortlistSet(token, causes);
    }

    /// @inheritdoc IEpochGovernor
    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        isRegistered[token] = true;
    }

    // ------------------------------------------------------------------ lifecycle

    /// @inheritdoc IEpochGovernor
    function openEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch != currentEpoch()) revert EpochNotCurrent(epoch);
        if (_epochs[token][epoch].opened) revert EpochAlreadyOpened(token, epoch);
        _openEpoch(token, epoch);
    }

    /// @inheritdoc IBallotGovernor
    /// @dev Called by the scheme while the voter's `castBallot` transaction executes. Opens the
    ///      epoch lazily, which re-enters the calling scheme through `open`; schemes call this
    ///      before checking that their poll is open.
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64 weight)
    {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (scope != currentEpoch()) revert EpochNotCurrent(scope);

        EpochState storage s = _epochs[token][scope];
        IVotingScheme expected = s.opened ? s.scheme : _scheme;
        if (msg.sender != address(expected)) revert NotScheme(msg.sender);
        if (!s.opened) _openEpoch(token, scope);

        if (s.voted[voter]) revert AlreadyVoted(voter);
        weight = _weightAt(token, snapshotOf(scope), voter);
        if (weight == 0) revert InvalidVote();

        s.voted[voter] = true;
        unchecked {
            ++s.voters;
        }
        emit VoteCast(token, scope, ballotRef);
    }

    /// @inheritdoc IEpochGovernor
    function closeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);
        EpochState storage s = _epochs[token][epoch];
        if (!s.opened) revert EpochNotOpened(token, epoch);
        if (s.closed) revert EpochAlreadyClosed(token, epoch);
        s.closed = true;
        s.scheme.requestTally(token, epoch);
        emit EpochClosed(token, epoch);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev With no ballots (or a tally that counted nothing) the owner-set `defaultCause` wins;
    ///      if none is set, or it is inactive, this reverts with `NoVotes` until one is. The winner
    ///      is stored even if the cause was deactivated after the vote; the distributor resolves
    ///      its payout from the registry, which keeps deactivated records.
    function finalizeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);

        EpochState storage s = _epochs[token][epoch];
        if (s.finalized) revert EpochAlreadyFinalized(token, epoch);

        bytes32 winner;
        uint256 best;
        if (s.opened && s.voters != 0) {
            (bool isFinal, uint64[] memory counts) = s.scheme.tallyOf(address(this), token, epoch);
            if (!isFinal) revert TallyNotFinal(token, epoch);
            bytes32[] storage options = s.options;
            uint256 n = options.length;
            if (counts.length != n) revert InvalidTally(token, epoch);
            for (uint256 i; i < n; ++i) {
                _tally[token][epoch][options[i]] = counts[i];
                // Strictly greater, so ties go to the lowest index.
                if (counts[i] > best) {
                    best = counts[i];
                    winner = options[i];
                }
            }
        }
        if (best == 0) {
            winner = defaultCause;
            if (winner == bytes32(0) || !registry.isActive(winner)) revert NoVotes(token, epoch);
            emit NoVoteFallbackApplied(token, epoch, winner);
        }

        s.finalized = true;
        s.winner = winner;
        emit EpochFinalized(token, epoch, winner);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IEpochGovernor
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - epochZeroStart) / EPOCH_LENGTH;
    }

    /// @inheritdoc IEpochGovernor
    function epochStart(uint256 epoch) public view returns (uint256) {
        return epochZeroStart + epoch * EPOCH_LENGTH;
    }

    /// @inheritdoc IEpochGovernor
    function snapshotOf(uint256 epoch) public view returns (uint256) {
        return epochStart(epoch) - 1;
    }

    /// @inheritdoc IEpochGovernor
    function scheme() external view returns (address) {
        return address(_scheme);
    }

    /// @inheritdoc IEpochGovernor
    function defaultShortlist() external view returns (bytes32[] memory) {
        return _defaultShortlist;
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        return _shortlists[token];
    }

    /// @inheritdoc IEpochGovernor
    function epochOptions(address token, uint256 epoch) external view returns (bytes32[] memory) {
        return _epochs[token][epoch].options;
    }

    /// @inheritdoc IEpochGovernor
    function epochScheme(address token, uint256 epoch) external view returns (address) {
        return address(_epochs[token][epoch].scheme);
    }

    /// @inheritdoc IEpochGovernor
    function isOpened(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].opened;
    }

    /// @inheritdoc IEpochGovernor
    function isClosed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closed;
    }

    /// @inheritdoc IEpochGovernor
    function isFinalized(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].finalized;
    }

    /// @inheritdoc IEpochGovernor
    function winningCause(address token, uint256 epoch) external view returns (bytes32) {
        return _epochs[token][epoch].winner;
    }

    /// @inheritdoc IEpochGovernor
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256) {
        return _tally[token][epoch][causeId];
    }

    /// @inheritdoc IEpochGovernor
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool) {
        return _epochs[token][epoch].voted[voter];
    }

    /// @inheritdoc IEpochGovernor
    function voterCount(address token, uint256 epoch) external view returns (uint256) {
        return _epochs[token][epoch].voters;
    }

    /// @inheritdoc IEpochGovernor
    function weightOf(address token, uint256 epoch, address account)
        external
        view
        returns (uint64)
    {
        return _weightAt(token, snapshotOf(epoch), account);
    }

    // ------------------------------------------------------------------ internals

    function _openEpoch(address token, uint256 epoch) private {
        bytes32[] storage source =
            _shortlists[token].length != 0 ? _shortlists[token] : _defaultShortlist;
        if (source.length == 0) revert NoShortlist(token);

        EpochState storage s = _epochs[token][epoch];
        s.opened = true;
        s.scheme = _scheme;
        s.options = source;
        // Shortlists are capped at MAX_OPTIONS, which fits a uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        _scheme.open(token, epoch, uint8(source.length));
        emit EpochOpened(token, epoch, source);
    }

    /// @dev Whole-token vote checkpoint of `account` at `snapshot`, capped to 64 bits; zero while
    ///      the snapshot is not yet in the past.
    function _weightAt(address token, uint256 snapshot, address account)
        private
        view
        returns (uint64)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) return 0;
        uint256 whole = IVotes(token).getPastVotes(account, snapshot) / 1e18;
        // Capped just above, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
    }

    /// @dev 1..MAX_OPTIONS active, distinct causes.
    function _validateShortlist(bytes32[] calldata causes) private view {
        uint256 n = causes.length;
        if (n == 0 || n > MAX_OPTIONS) revert InvalidShortlist();
        for (uint256 i; i < n; ++i) {
            bytes32 causeId = causes[i];
            if (!registry.isActive(causeId)) revert InactiveCause(causeId);
            for (uint256 j; j < i; ++j) {
                if (causes[j] == causeId) revert InvalidShortlist();
            }
        }
    }
}
