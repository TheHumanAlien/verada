// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IVoteVerifier} from "./interfaces/IVoteVerifier.sol";

/// @title EpochGovernor
/// @notice Weekly epochs in which holders pick the cause that receives a token's cause pool.
/// @dev Vote validity, weight and double-vote protection are delegated to a pluggable
///      `IVoteVerifier`, so a private voting scheme can replace the verifier later. The governor
///      tracks the leading cause incrementally, making `finalizeEpoch` O(1). Ties go to the cause
///      that reached the leading weight first.
contract EpochGovernor is IEpochGovernor, Ownable2Step {
    /// @inheritdoc IEpochGovernor
    uint256 public constant EPOCH_LENGTH = 7 days;

    /// @inheritdoc IEpochGovernor
    uint256 public immutable epochZeroStart;

    ICauseRegistry public immutable registry;

    /// @notice Verifier used to validate votes.
    IVoteVerifier public verifier;

    /// @notice Factory allowed to register tokens (set once by the owner).
    address public factory;

    event VerifierUpdated(address indexed verifier);
    event FactorySet(address indexed factory);
    event DefaultCauseSet(bytes32 indexed causeId);
    event NoVoteFallbackApplied(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Cause that wins an epoch in which nobody voted (zero means no fallback).
    bytes32 public defaultCause;

    error ZeroAddress();
    error FactoryAlreadySet();

    struct EpochState {
        bytes32 leader;
        uint256 leaderWeight;
        bool finalized;
        bytes32 winner;
    }

    mapping(address token => bool) public isRegistered;
    mapping(address token => mapping(uint256 epoch => EpochState)) private _epochs;
    mapping(address token => mapping(uint256 epoch => mapping(bytes32 causeId => uint256))) private
        _tally;
    mapping(address token => mapping(uint256 epoch => mapping(bytes32 voteRef => bool))) private
        _voteUsed;

    /// @param initialOwner Admin allowed to set the factory once and swap the verifier.
    /// @param registry_ Cause registry used to check that voted causes are active.
    /// @param verifier_ Initial vote verifier.
    constructor(address initialOwner, ICauseRegistry registry_, IVoteVerifier verifier_)
        Ownable(initialOwner)
    {
        if (address(registry_) == address(0) || address(verifier_) == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        verifier = verifier_;
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

    /// @notice Replaces the vote verifier. Votes already tallied are unaffected; vote references
    ///         are tracked here, so a new verifier cannot replay old ones within an epoch.
    function setVerifier(IVoteVerifier verifier_) external onlyOwner {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
        emit VerifierUpdated(address(verifier_));
    }

    /// @notice Sets the fallback cause paid when an epoch ends with no votes, so its funds are
    ///         never stranded. Zero clears the fallback; otherwise the cause must be active.
    function setDefaultCause(bytes32 causeId) external onlyOwner {
        if (causeId != bytes32(0) && !registry.isActive(causeId)) revert InactiveCause(causeId);
        defaultCause = causeId;
        emit DefaultCauseSet(causeId);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IEpochGovernor
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - epochZeroStart) / EPOCH_LENGTH;
    }

    /// @inheritdoc IEpochGovernor
    function winningCause(address token, uint256 epoch) external view returns (bytes32) {
        return _epochs[token][epoch].winner;
    }

    /// @inheritdoc IEpochGovernor
    function isFinalized(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].finalized;
    }

    /// @inheritdoc IEpochGovernor
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256) {
        return _tally[token][epoch][causeId];
    }

    // ------------------------------------------------------------------ actions

    /// @inheritdoc IEpochGovernor
    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        isRegistered[token] = true;
    }

    /// @inheritdoc IEpochGovernor
    function castVote(address token, bytes32 causeId, bytes calldata proof) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (!registry.isActive(causeId)) revert InactiveCause(causeId);

        uint256 epoch = currentEpoch();
        (bool valid, uint256 weight, bytes32 voteRef) =
            verifier.verifyVote(token, epoch, causeId, proof);
        if (!valid || weight == 0) revert InvalidVote();
        if (_voteUsed[token][epoch][voteRef]) revert VoteAlreadyUsed(voteRef);
        _voteUsed[token][epoch][voteRef] = true;

        uint256 total = _tally[token][epoch][causeId] + weight;
        _tally[token][epoch][causeId] = total;

        EpochState storage s = _epochs[token][epoch];
        if (total > s.leaderWeight) {
            s.leaderWeight = total;
            s.leader = causeId;
        }

        emit VoteCast(token, epoch, voteRef);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev Permissionless. With no votes the owner-set `defaultCause` wins; if none is set (or it
    ///      is inactive) this reverts with `NoVotes`. The winner is stored even if the cause was deactivated after the vote;
    ///      the distributor resolves its payout from the registry, which keeps deactivated records.
    function finalizeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);

        EpochState storage s = _epochs[token][epoch];
        if (s.finalized) revert EpochAlreadyFinalized(token, epoch);

        bytes32 winner = s.leader;
        if (s.leaderWeight == 0) {
            // No votes: fall back to the default cause so the epoch's funds can still be settled.
            winner = defaultCause;
            if (winner == bytes32(0) || !registry.isActive(winner)) revert NoVotes(token, epoch);
            emit NoVoteFallbackApplied(token, epoch, winner);
        }

        s.finalized = true;
        s.winner = winner;
        emit EpochFinalized(token, epoch, winner);
    }
}
