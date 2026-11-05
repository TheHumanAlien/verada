// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IEpochGovernor
/// @notice Weekly epochs in which token holders choose the cause receiving the cause pool.
interface IEpochGovernor {
    /// @notice Emitted when a vote is cast. `voteRef` is opaque so private schemes can replace it.
    event VoteCast(address indexed token, uint256 indexed epoch, bytes32 voteRef);

    /// @notice Emitted when an epoch is finalized with its winning cause.
    event EpochFinalized(address indexed token, uint256 indexed epoch, bytes32 causeId);

    error NotFactory();
    error TokenNotRegistered(address token);
    error EpochNotEnded(uint256 epoch);
    error EpochAlreadyFinalized(address token, uint256 epoch);
    error InactiveCause(bytes32 causeId);
    error InvalidVote();
    error VoteAlreadyUsed(bytes32 voteRef);
    error NoVotes(address token, uint256 epoch);

    /// @notice Length of an epoch in seconds.
    function EPOCH_LENGTH() external view returns (uint256);

    /// @notice Timestamp at which epoch 0 starts.
    function epochZeroStart() external view returns (uint256);

    /// @notice Index of the current epoch.
    function currentEpoch() external view returns (uint256);

    /// @notice Registers a token for voting. Callable by the factory only.
    function registerToken(address token) external;

    /// @notice Casts a vote for `causeId` in the current epoch.
    function castVote(address token, bytes32 causeId, bytes calldata proof) external;

    /// @notice Tallies a past epoch and stores the winning cause.
    function finalizeEpoch(address token, uint256 epoch) external;

    /// @notice Winning cause of a finalized epoch (zero if not finalized).
    function winningCause(address token, uint256 epoch) external view returns (bytes32);

    /// @notice Whether the epoch has been finalized.
    function isFinalized(address token, uint256 epoch) external view returns (bool);

    /// @notice Accumulated weight for a cause in an epoch.
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256);
}
