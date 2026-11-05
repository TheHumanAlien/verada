// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVotingScheme
/// @notice Pluggable ballot box used by the governors. A poll is keyed by the calling governor,
///         the token and a governor-chosen `scope` (an epoch index or a proposal id). The governor
///         decides who may vote and with what weight; the scheme decides how choices are hidden
///         and how the final per-option counts are produced and verified.
/// @dev Option indices are `0 .. optionCount-1`. Weights are in whole tokens so that totals fit
///      in 64 bits. A scheme may hide the choice (e.g. FHE) and reveal only aggregates.
interface IVotingScheme {
    event PollOpened(
        address indexed governor, address indexed token, uint256 indexed scope, uint8 optionCount
    );
    event BallotCast(
        address indexed governor,
        address indexed token,
        uint256 indexed scope,
        address voter,
        uint64 weight,
        bytes32 ballotRef
    );
    event TallyRequested(address indexed governor, address indexed token, uint256 indexed scope);
    event TallySubmitted(
        address indexed governor, address indexed token, uint256 indexed scope, uint64[] counts
    );

    error NotGovernor(address caller);
    error PollNotOpen(address governor, address token, uint256 scope);
    error PollAlreadyOpen(address governor, address token, uint256 scope);
    error PollClosed(address governor, address token, uint256 scope);
    error PollNotClosed(address governor, address token, uint256 scope);
    error TallyAlreadyFinal(address governor, address token, uint256 scope);
    error InvalidOptionCount(uint8 optionCount);
    error AlreadyVoted(address voter);
    error ZeroWeight();
    error InvalidBallot();

    /// @notice Opens a poll. Governor only.
    function open(address token, uint256 scope, uint8 optionCount) external;

    /// @notice Records a ballot for `voter` with `weight`. Governor only; one ballot per voter.
    /// @return ballotRef Opaque reference emitted by the governor as `voteRef`.
    function castBallot(
        address token,
        uint256 scope,
        address voter,
        uint64 weight,
        bytes calldata ballot
    ) external returns (bytes32 ballotRef);

    /// @notice Closes the poll and asks for the aggregate to be revealed. Governor only.
    function requestTally(address token, uint256 scope) external;

    /// @notice Publishes the verified per-option counts of a closed poll. Permissionless; the
    ///         scheme verifies `proof` (e.g. KMS signatures over the decrypted aggregates).
    function submitTally(
        address governor,
        address token,
        uint256 scope,
        bytes calldata cleartexts,
        bytes calldata proof
    ) external;

    /// @notice Final counts of a poll, if available.
    function tallyOf(address governor, address token, uint256 scope)
        external
        view
        returns (bool isFinal, uint64[] memory counts);

    /// @notice Whether `voter` already cast a ballot in the poll.
    function hasVoted(address governor, address token, uint256 scope, address voter)
        external
        view
        returns (bool);

    /// @notice Number of ballots recorded in the poll.
    function ballotCount(address governor, address token, uint256 scope)
        external
        view
        returns (uint256);

    /// @notice Whether the poll is open for ballots.
    function isOpen(address governor, address token, uint256 scope) external view returns (bool);

    /// @notice Largest option count a poll may have.
    function MAX_OPTIONS() external view returns (uint8);
}
