// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IEpochGovernor
/// @notice Weekly epochs in which token holders choose the cause receiving the cause pool.
/// @dev Each epoch of a token is a poll on the pluggable voting scheme. The options are the
///      token's shortlist of causes (or the platform default), frozen when the epoch is opened.
///      Voters do not call the governor: they call
///      `IVotingScheme.castBallot(address(governor), token, epoch, ballot)` on the scheme the epoch
///      was opened with, which calls back `authorizeBallot` so the governor can check eligibility
///      and return the voter's weight. Weight is the voter's vote checkpoint at `snapshotOf(epoch)`
///      (the second before the epoch starts), in whole tokens. The voter and weight are public; the
///      choice is as private as the scheme makes it.
interface IEpochGovernor {
    /// @notice Emitted when a vote is cast. `voteRef` is opaque so private schemes can replace it.
    event VoteCast(address indexed token, uint256 indexed epoch, bytes32 voteRef);

    /// @notice Emitted when an epoch is finalized with its winning cause.
    event EpochFinalized(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Emitted when an epoch's poll is opened with its frozen options.
    event EpochOpened(address indexed token, uint256 indexed epoch, bytes32[] options);

    /// @notice Emitted when an epoch's poll is closed and the tally requested.
    event EpochClosed(address indexed token, uint256 indexed epoch);

    /// @notice Emitted when an epoch with no ballots falls back to the default cause.
    event NoVoteFallbackApplied(address indexed token, uint256 indexed epoch, bytes32 causeId);

    event SchemeUpdated(address indexed scheme);
    event FactorySet(address indexed factory);
    event DefaultCauseSet(bytes32 indexed causeId);
    event DefaultShortlistSet(bytes32[] causes);
    event ShortlistSet(address indexed token, bytes32[] causes);

    error NotFactory();
    error NotScheme(address caller);
    error NotController(address token, address caller);
    error TokenNotRegistered(address token);
    error EpochNotEnded(uint256 epoch);
    error EpochNotCurrent(uint256 epoch);
    error EpochNotOpened(address token, uint256 epoch);
    error EpochAlreadyOpened(address token, uint256 epoch);
    error EpochAlreadyClosed(address token, uint256 epoch);
    error EpochAlreadyFinalized(address token, uint256 epoch);
    error TallyNotFinal(address token, uint256 epoch);
    error InvalidTally(address token, uint256 epoch);
    error InactiveCause(bytes32 causeId);
    error InvalidShortlist();
    error NoShortlist(address token);
    error InvalidVote();
    error AlreadyVoted(address voter);
    error NoVotes(address token, uint256 epoch);
    error ZeroAddress();
    error FactoryAlreadySet();

    // ------------------------------------------------------------------ constants / config

    /// @notice Length of an epoch in seconds.
    function EPOCH_LENGTH() external view returns (uint256);

    /// @notice Largest number of causes a shortlist may hold.
    function MAX_OPTIONS() external view returns (uint8);

    /// @notice Timestamp at which epoch 0 starts.
    function epochZeroStart() external view returns (uint256);

    /// @notice Index of the current epoch.
    function currentEpoch() external view returns (uint256);

    /// @notice Start timestamp of `epoch`.
    function epochStart(uint256 epoch) external view returns (uint256);

    /// @notice Timestamp at which voting weights for `epoch` are read (the second before it starts).
    function snapshotOf(uint256 epoch) external view returns (uint256);

    /// @notice Voting scheme used for epochs opened from now on.
    function scheme() external view returns (address);

    /// @notice Cause that wins an epoch in which nobody voted (zero means no fallback).
    function defaultCause() external view returns (bytes32);

    /// @notice Shortlist used by tokens without one of their own.
    function defaultShortlist() external view returns (bytes32[] memory);

    /// @notice The token's own shortlist (empty when it uses the default).
    function shortlistOf(address token) external view returns (bytes32[] memory);

    // ------------------------------------------------------------------ admin

    /// @notice Registers a token for voting. Callable by the factory only.
    function registerToken(address token) external;

    /// @notice Sets the shortlist offered to tokens without their own. Owner only.
    function setDefaultShortlist(bytes32[] calldata causes) external;

    /// @notice Sets a token's shortlist. Callable by the token's profile controller only. An empty
    ///         list removes the token's shortlist so it falls back to the default.
    function setShortlist(address token, bytes32[] calldata causes) external;

    // ------------------------------------------------------------------ lifecycle

    /// @notice Opens the current epoch's poll for `token`, freezing its options. Permissionless;
    ///         also done lazily by the first ballot.
    function openEpoch(address token, uint256 epoch) external;

    /// @notice Closes an ended epoch's poll and asks the scheme for the tally. Permissionless.
    function closeEpoch(address token, uint256 epoch) external;

    /// @notice Stores the winning cause of an ended epoch from the scheme's final tally, or the
    ///         default cause when nobody voted. Permissionless.
    function finalizeEpoch(address token, uint256 epoch) external;

    // ------------------------------------------------------------------ epoch views

    /// @notice Options frozen for `(token, epoch)` (empty if not opened).
    function epochOptions(address token, uint256 epoch) external view returns (bytes32[] memory);

    /// @notice Scheme the epoch was opened with (zero if not opened).
    function epochScheme(address token, uint256 epoch) external view returns (address);

    function isOpened(address token, uint256 epoch) external view returns (bool);
    function isClosed(address token, uint256 epoch) external view returns (bool);

    /// @notice Whether the epoch has been finalized.
    function isFinalized(address token, uint256 epoch) external view returns (bool);

    /// @notice Winning cause of a finalized epoch (zero if not finalized).
    function winningCause(address token, uint256 epoch) external view returns (bytes32);

    /// @notice Final weight counted for a cause in a finalized epoch (zero when the cause was not on
    ///         the ballot or the epoch fell back to the default cause).
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256);

    /// @notice Whether `voter` cast a ballot in the epoch.
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool);

    /// @notice Number of ballots authorized in the epoch.
    function voterCount(address token, uint256 epoch) external view returns (uint256);

    /// @notice Voting weight of `account` in `epoch`, in whole tokens at the snapshot (zero while
    ///         the snapshot is still in the future).
    function weightOf(address token, uint256 epoch, address account) external view returns (uint64);
}
