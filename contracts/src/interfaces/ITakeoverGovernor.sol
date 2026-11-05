// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ITakeoverGovernor
/// @notice Community takeover: holders of a token vote to replace the account controlling the
///         token's profile (ENS records, logo, website). Choices are cast through the pluggable
///         voting scheme; weights come from the token's vote checkpoints at the proposal snapshot.
interface ITakeoverGovernor {
    enum State {
        None,
        Active,
        Closing,
        Defeated,
        Succeeded,
        Executed,
        Canceled,
        Expired
    }

    struct Params {
        /// @dev Seconds a proposal accepts ballots.
        uint32 votingPeriod;
        /// @dev Seconds after the vote ends during which a successful proposal can be executed.
        uint32 executionWindow;
        /// @dev Seconds after a proposal ends before a new one may be created for the same token.
        uint32 cooldown;
        /// @dev Seconds after a token's registration before it can be targeted.
        uint32 minTokenAge;
        /// @dev FOR weight needed, in basis points of total supply (whole tokens) at creation.
        uint16 quorumBps;
        /// @dev Proposer weight needed, in basis points of total supply (whole tokens).
        uint16 proposalThresholdBps;
    }

    struct Proposal {
        address token;
        address proposer;
        address newController;
        uint48 start;
        uint48 end;
        uint48 executionDeadline;
        uint48 snapshot;
        bool executed;
        bool canceled;
        uint64 quorumWeight;
        uint64 forWeight;
        uint64 againstWeight;
        bool tallied;
    }

    event TakeoverProposed(
        address indexed token,
        uint256 indexed proposalId,
        address indexed proposer,
        address newController,
        uint48 start,
        uint48 end,
        uint64 quorumWeight
    );
    event TakeoverVoteCast(address indexed token, uint256 indexed proposalId, bytes32 voteRef);
    event TakeoverClosed(address indexed token, uint256 indexed proposalId);
    event TakeoverTallied(
        address indexed token, uint256 indexed proposalId, uint64 forWeight, uint64 againstWeight
    );
    event TakeoverExecuted(
        address indexed token, uint256 indexed proposalId, address indexed newController
    );
    event TakeoverCanceled(address indexed token, uint256 indexed proposalId);
    event ParamsUpdated(Params params);
    event SchemeUpdated(address indexed scheme);

    error TokenNotRegistered(address token);
    error ProposalPending(address token, uint256 proposalId);
    error CooldownActive(address token, uint256 availableAt);
    error TokenTooYoung(address token, uint256 eligibleAt);
    error InvalidNewController(address newController);
    error BelowProposalThreshold(uint64 weight, uint64 required);
    error InvalidVote();
    error VotingClosed(uint256 proposalId);
    error VotingNotEnded(uint256 proposalId);
    error TallyNotFinal(uint256 proposalId);
    error NotExecutable(uint256 proposalId, State state);
    error NotCancelable(uint256 proposalId, State state);
    error NotProposer();
    error UnknownProposal(uint256 proposalId);
    error InvalidParams();
    error ZeroAddress();

    /// @notice Index of the AGAINST option in the poll.
    function AGAINST() external view returns (uint8);
    /// @notice Index of the FOR option in the poll.
    function FOR() external view returns (uint8);

    /// @notice Opens a takeover proposal. The proposer must hold the proposal threshold.
    function propose(address token, address newController) external returns (uint256 proposalId);

    /// @notice Casts the caller's ballot (scheme-specific encoding of FOR/AGAINST).
    function castBallot(uint256 proposalId, bytes calldata ballot) external;

    /// @notice Closes voting after the period ends and asks the scheme for the tally.
    function closeProposal(uint256 proposalId) external;

    /// @notice Reads the scheme's final tally into the proposal. Permissionless.
    function recordTally(uint256 proposalId) external;

    /// @notice Executes a successful proposal, replacing the token's controller.
    function execute(uint256 proposalId) external;

    /// @notice Cancels a proposal: the proposer while active, the owner at any time before execution.
    function cancel(uint256 proposalId) external;

    function state(uint256 proposalId) external view returns (State);
    function getProposal(uint256 proposalId) external view returns (Proposal memory);
    function activeProposalOf(address token) external view returns (uint256);
    function lastProposalEnd(address token) external view returns (uint256);
    function proposalCount() external view returns (uint256);
    function params() external view returns (Params memory);
    function scheme() external view returns (address);
    function registry() external view returns (address);
    /// @notice Voting weight of `account` for `proposalId` (whole tokens at the snapshot).
    function weightOf(uint256 proposalId, address account) external view returns (uint64);
}
