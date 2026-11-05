// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ITakeoverGovernor
/// @notice Community takeover: holders of a token vote to replace the account controlling the
///         token's profile (ENS records, logo, website). Choices are cast through the pluggable
///         voting scheme; weights come from the token's vote checkpoints at the proposal snapshot.
/// @dev Voters do not call the governor. They call
///      `IVotingScheme.castBallot(address(governor), token, proposalId, ballot)` on the scheme the
///      proposal was opened with; the scheme calls back `IBallotGovernor.authorizeBallot`, which
///      checks the proposal is active, the voter has not voted and returns their weight in whole
///      tokens: the smaller of their votes at the snapshot (the second before the proposal was
///      created) and at `snapshot - lookback`, so votes must have been held through the lookback.
///      Quorum and the proposal threshold are fractions of the circulating supply at the
///      snapshot, which excludes the Uniswap PoolManager's balance. Several proposals may run
///      for the same token at once (at most one pending per proposer, with a per-proposer
///      cooldown); executing one supersedes every other proposal of that token created before it.
interface ITakeoverGovernor {
    enum State {
        None,
        Active,
        Closing,
        Defeated,
        Succeeded,
        Executed,
        Canceled,
        Expired,
        /// @dev Another proposal of the same token was executed after this one was created.
        Superseded
    }

    struct Params {
        /// @dev Seconds a proposal accepts ballots.
        uint32 votingPeriod;
        /// @dev Seconds after the vote ends during which a successful proposal can be executed.
        uint32 executionWindow;
        /// @dev Seconds after a proposer's proposal ends (or is canceled) before the same
        ///      proposer may propose again for the same token.
        uint32 cooldown;
        /// @dev Seconds after a token's registration before it can be targeted.
        uint32 minTokenAge;
        /// @dev FOR weight needed, in basis points of the circulating supply (whole tokens) at
        ///      the snapshot.
        uint16 quorumBps;
        /// @dev Proposer weight needed, in basis points of the circulating supply (whole tokens).
        ///      At least 1 and at most `quorumBps`; the required weight is never below one
        ///      whole token, so an account without voting weight cannot propose.
        uint16 proposalThresholdBps;
        /// @dev Seconds before the snapshot at which votes must already have been held: weights
        ///      are the minimum of the two checkpoints.
        uint32 lookback;
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
        /// @dev `snapshot - lookback`: the second checkpoint weights are read at.
        uint48 lookbackSnapshot;
        /// @dev Circulating supply at the snapshot in whole tokens (total supply minus the
        ///      PoolManager's votes); quorum and threshold are fractions of it.
        uint64 circulatingWeight;
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
    /// @notice Every proposal of `token` created before `executedProposalId` was executed and not
    ///         yet executed, canceled, defeated or expired is now `Superseded`.
    event TakeoverSuperseded(address indexed token, uint256 indexed executedProposalId);
    event ParamsUpdated(Params params);
    event SchemeUpdated(address indexed scheme);

    error TokenNotRegistered(address token);
    error ProposalPending(address token, uint256 proposalId);
    error CooldownActive(address token, uint256 availableAt);
    error TokenTooYoung(address token, uint256 eligibleAt);
    error InvalidNewController(address newController);
    error BelowProposalThreshold(uint64 weight, uint64 required);
    error NotScheme(address caller);
    error InvalidVote();
    error AlreadyVoted(address voter);
    error VotingClosed(uint256 proposalId);
    error VotingNotEnded(uint256 proposalId);
    error NotClosable(uint256 proposalId, State state);
    error AlreadyClosed(uint256 proposalId);
    error NotClosed(uint256 proposalId);
    error AlreadyTallied(uint256 proposalId);
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

    /// @notice Closes voting after the period ends and asks the scheme for the tally.
    function closeProposal(uint256 proposalId) external;

    /// @notice Reads the scheme's final tally into the proposal. Permissionless.
    function recordTally(uint256 proposalId) external;

    /// @notice Executes a successful proposal, replacing the token's controller. Supersedes every
    ///         other proposal of the token created before it.
    function execute(uint256 proposalId) external;

    /// @notice Cancels an active proposal (voting still open). Callable by the proposer or the
    ///         owner. The proposer's cooldown restarts from the cancellation.
    function cancel(uint256 proposalId) external;

    /// @notice Replaces the parameters for proposals created from now on. Owner only.
    function setParams(Params calldata params_) external;

    /// @notice Replaces the voting scheme for proposals created from now on. Owner only.
    function setScheme(address scheme_) external;

    function state(uint256 proposalId) external view returns (State);
    function getProposal(uint256 proposalId) external view returns (Proposal memory);
    /// @notice Most recent proposal of `token` that is Active, Closing or Succeeded (zero if none).
    ///         Several may be pending at once; see `activeProposalsOf`.
    function activeProposalOf(address token) external view returns (uint256);
    /// @notice Every proposal of `token` that is Active, Closing or Succeeded, newest first.
    function activeProposalsOf(address token) external view returns (uint256[] memory);
    /// @notice Every proposal id ever created for `token`, oldest first.
    function proposalsOf(address token) external view returns (uint256[] memory);
    /// @notice End of the most recent proposal created for `token` (informational; cooldowns are
    ///         per proposer, see `cooldownAnchorOf`).
    function lastProposalEnd(address token) external view returns (uint256);
    /// @notice Latest proposal `proposer` created for `token` (zero if none).
    function latestProposalOf(address token, address proposer) external view returns (uint256);
    /// @notice Timestamp `proposer`'s cooldown for `token` runs from: the end of their latest
    ///         proposal, or its cancellation time (zero if they never proposed).
    function cooldownAnchorOf(address token, address proposer) external view returns (uint256);
    /// @notice Uniswap v4 PoolManager whose balance is excluded from the circulating supply.
    function poolManager() external view returns (address);
    function proposalCount() external view returns (uint256);
    function params() external view returns (Params memory);
    function scheme() external view returns (address);
    function registry() external view returns (address);
    /// @notice Scheme the proposal was opened with (zero for unknown proposals).
    function proposalScheme(uint256 proposalId) external view returns (address);
    /// @notice Whether the proposal's poll was closed (tally requested).
    function isClosed(uint256 proposalId) external view returns (bool);
    /// @notice Whether `voter` cast a ballot in the proposal.
    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    /// @notice Voting weight of `account` for `proposalId`: whole tokens, the smaller of the
    ///         checkpoints at the snapshot and at the lookback snapshot.
    function weightOf(uint256 proposalId, address account) external view returns (uint64);
}
