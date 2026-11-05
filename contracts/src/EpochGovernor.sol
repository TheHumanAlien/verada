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
///      token's vote checkpoints at `snapshotOf(epoch)` in whole tokens. Shortlist changes are
///      scheduled for the next epoch so a running epoch's options are fixed from its start, and
///      an epoch whose tally never arrives (scheme outage, governor delisted) finalizes to the
///      default cause once `TALLY_GRACE` has passed, so its cause pool cannot be stranded.
contract EpochGovernor is IEpochGovernor, IBallotGovernor, Ownable2Step {
    /// @inheritdoc IEpochGovernor
    uint256 public constant EPOCH_LENGTH = 7 days;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MAX_OPTIONS = 10;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MIN_OPTIONS = 2;

    /// @inheritdoc IEpochGovernor
    uint256 public constant TALLY_GRACE = 14 days;

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

    /// @dev A shortlist in effect (`current`) and an optional replacement (`next`) taking effect
    ///      from epoch `nextFrom` (zero: none scheduled).
    struct Schedule {
        bytes32[] current;
        bytes32[] next;
        uint256 nextFrom;
    }

    Schedule private _defaultShortlist;

    /// @dev Outcome of reading an epoch's tally from its scheme.
    enum TallyStatus {
        Valid,
        NotFinal,
        Invalid
    }

    struct EpochState {
        bool opened;
        bool closed;
        bool finalized;
        bool closeFailed;
        IVotingScheme scheme;
        bytes32 winner;
        uint256 voters;
        bytes32[] options;
        mapping(address voter => bool) voted;
    }

    mapping(address token => bool) public isRegistered;
    mapping(address token => Schedule) private _shortlists;
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
        Schedule storage d = _defaultShortlist;
        // With no default in effect no token without its own list could open the current epoch,
        // so the new list may apply at once.
        uint256 effectiveFrom = _schedule(d, causes, _listAt(d, currentEpoch()).length == 0);
        emit DefaultShortlistSet(causes);
        emit DefaultShortlistScheduled(effectiveFrom, causes);
    }

    /// @inheritdoc IEpochGovernor
    function setShortlist(address token, bytes32[] calldata causes) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
        if (causes.length != 0) _validateShortlist(causes);
        // With no list in effect (own or default) the current epoch cannot have been opened, so
        // the new list may apply at once; otherwise it waits for the next epoch.
        uint256 effectiveFrom =
            _schedule(_shortlists[token], causes, _resolve(token, currentEpoch()).length == 0);
        emit ShortlistSet(token, causes);
        emit ShortlistScheduled(token, effectiveFrom, causes);
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
        if (s.closed && !s.closeFailed) revert EpochAlreadyClosed(token, epoch);
        s.closed = true;
        uint256 gasBefore = gasleft();
        try s.scheme.requestTally(token, epoch) {
            s.closeFailed = false;
            emit EpochClosed(token, epoch);
        } catch {
            // A call starved of gas by the caller is not a scheme failure: revert so the epoch is
            // not marked failed on purpose. The callee gets at most 63/64 of the gas.
            if (gasleft() <= gasBefore / 64) revert InsufficientGas();
            s.closeFailed = true;
            emit EpochCloseFailed(token, epoch);
        }
    }

    /// @inheritdoc IEpochGovernor
    /// @dev With no ballots (or a tally that counted nothing) the owner-set `defaultCause` wins;
    ///      if none is set, or it is inactive, this reverts with `NoVotes` until one is. With
    ///      ballots but no valid final tally, this reverts until `TALLY_GRACE` after the epoch's
    ///      end and then falls back to `defaultCause` as well. The winner is stored even if the
    ///      cause was deactivated after the vote; the distributor resolves its payout from the
    ///      registry, which keeps deactivated records.
    function finalizeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);

        EpochState storage s = _epochs[token][epoch];
        if (s.finalized) revert EpochAlreadyFinalized(token, epoch);

        bytes32 winner;
        uint256 best;
        bool timedOut;
        if (s.opened && s.voters != 0) {
            bytes32[] storage options = s.options;
            uint256 n = options.length;
            (TallyStatus status, uint64[] memory counts) = _finalCounts(s.scheme, token, epoch, n);
            if (status == TallyStatus.Valid) {
                for (uint256 i; i < n; ++i) {
                    _tally[token][epoch][options[i]] = counts[i];
                    // Strictly greater, so ties go to the lowest index.
                    if (counts[i] > best) {
                        best = counts[i];
                        winner = options[i];
                    }
                }
            } else {
                // forge-lint: disable-next-line(block-timestamp)
                if (block.timestamp < epochStart(epoch + 1) + TALLY_GRACE) {
                    if (status == TallyStatus.Invalid) revert InvalidTally(token, epoch);
                    revert TallyNotFinal(token, epoch);
                }
                timedOut = true;
            }
        }
        if (best == 0) {
            winner = defaultCause;
            if (winner == bytes32(0) || !registry.isActive(winner)) revert NoVotes(token, epoch);
            if (timedOut) emit TallyTimeoutFallbackApplied(token, epoch, winner);
            else emit NoVoteFallbackApplied(token, epoch, winner);
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
        return _listAt(_defaultShortlist, currentEpoch());
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        return _listAt(_shortlists[token], currentEpoch());
    }

    /// @inheritdoc IEpochGovernor
    function shortlistFor(address token, uint256 epoch) external view returns (bytes32[] memory) {
        return _resolve(token, epoch);
    }

    /// @inheritdoc IEpochGovernor
    function pendingShortlistOf(address token)
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        return _pending(_shortlists[token]);
    }

    /// @inheritdoc IEpochGovernor
    function pendingDefaultShortlist()
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        return _pending(_defaultShortlist);
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
    function closeFailed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closeFailed;
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
        bytes32[] storage source = _resolve(token, epoch);
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

    /// @dev Final per-option counts of the epoch's poll. A reverting scheme reads as not final.
    function _finalCounts(IVotingScheme scheme_, address token, uint256 epoch, uint256 n)
        private
        view
        returns (TallyStatus status, uint64[] memory counts)
    {
        try scheme_.tallyOf(address(this), token, epoch) returns (bool isFinal, uint64[] memory c) {
            if (!isFinal) return (TallyStatus.NotFinal, c);
            if (c.length != n) return (TallyStatus.Invalid, c);
            return (TallyStatus.Valid, c);
        } catch {
            return (TallyStatus.NotFinal, counts);
        }
    }

    /// @dev List of `s` in effect for `epoch` (exact for epochs at or after the one in which the
    ///      schedule last changed, which covers the current and later epochs).
    function _listAt(Schedule storage s, uint256 epoch) private view returns (bytes32[] storage) {
        uint256 from = s.nextFrom;
        return from != 0 && epoch >= from ? s.next : s.current;
    }

    /// @dev Token's own list for `epoch`, or else the default list for `epoch`.
    function _resolve(address token, uint256 epoch) private view returns (bytes32[] storage) {
        bytes32[] storage own = _listAt(_shortlists[token], epoch);
        return own.length != 0 ? own : _listAt(_defaultShortlist, epoch);
    }

    function _pending(Schedule storage s)
        private
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        uint256 from = s.nextFrom;
        if (from == 0 || currentEpoch() >= from) return (causes, 0);
        return (s.next, from);
    }

    /// @dev Replaces the list of `s` from the next epoch, or from the current one when
    ///      `immediate`. Returns the epoch from which `causes` apply.
    function _schedule(Schedule storage s, bytes32[] calldata causes, bool immediate)
        private
        returns (uint256 effectiveFrom)
    {
        uint256 current = currentEpoch();
        uint256 from = s.nextFrom;
        if (from != 0 && current >= from) s.current = s.next;
        if (immediate) {
            s.current = causes;
            delete s.next;
            delete s.nextFrom;
            return current;
        }
        s.next = causes;
        s.nextFrom = current + 1;
        return current + 1;
    }

    /// @dev MIN_OPTIONS..MAX_OPTIONS (and at most the current scheme's maximum) active, distinct
    ///      causes.
    function _validateShortlist(bytes32[] calldata causes) private view {
        uint256 n = causes.length;
        if (n < MIN_OPTIONS || n > MAX_OPTIONS || n > _scheme.MAX_OPTIONS()) {
            revert InvalidShortlist();
        }
        for (uint256 i; i < n; ++i) {
            bytes32 causeId = causes[i];
            if (!registry.isActive(causeId)) revert InactiveCause(causeId);
            for (uint256 j; j < i; ++j) {
                if (causes[j] == causeId) revert InvalidShortlist();
            }
        }
    }
}
