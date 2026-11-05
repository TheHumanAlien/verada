// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ITakeoverGovernor} from "./interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";

/// @title TakeoverGovernor
/// @notice Lets a token's holders replace the controller of its profile. A proposal is a
///         two-option poll (AGAINST / FOR) on the pluggable voting scheme; a voter's weight is
///         the smaller of their vote checkpoints at the proposal snapshot and `lookback` seconds
///         earlier, in whole tokens, so voting power cannot be bought just for the vote.
/// @dev Timing, quorum and scheme are captured per proposal when it is created, so parameter or
///      scheme changes never affect proposals already running. Quorum and the proposal threshold
///      are fractions of the circulating supply at the snapshot: the total supply minus the votes
///      of the Uniswap PoolManager, whose (self-delegated) balance can never vote. Any number of
///      proposals may run for a token at once, so no proposer can lock others out; each proposer
///      has at most one pending (active, closing or awaiting execution) proposal per token and a
///      cooldown between their own proposals. Executing a proposal supersedes every other
///      proposal of the token created before it, so a stale vote can never be executed over a
///      newer outcome. Supersession is tracked per execution through this governor rather than
///      by comparing controllers, so an incumbent cannot void running proposals by handing the
///      profile to another of their own accounts.
contract TakeoverGovernor is ITakeoverGovernor, IBallotGovernor, Ownable2Step {
    /// @inheritdoc ITakeoverGovernor
    uint8 public constant AGAINST = 0;
    /// @inheritdoc ITakeoverGovernor
    uint8 public constant FOR = 1;

    uint32 public constant MIN_PERIOD = 1 days;
    uint32 public constant MAX_PERIOD = 30 days;
    /// @notice Shortest execution window: leaves time for the tally's decryption pipeline.
    uint32 public constant MIN_EXECUTION_WINDOW = 2 days;
    uint32 public constant MAX_COOLDOWN = 90 days;
    uint32 public constant MAX_TOKEN_AGE = 90 days;
    uint32 public constant MIN_LOOKBACK = 1 days;
    uint32 public constant MAX_LOOKBACK = 90 days;
    uint16 public constant MIN_QUORUM_BPS = 50;
    uint16 public constant MAX_QUORUM_BPS = 5000;
    /// @notice Lowest proposal threshold: proposing always takes a stake in the token.
    uint16 public constant MIN_PROPOSAL_THRESHOLD_BPS = 1;

    uint8 private constant _OPTION_COUNT = 2;
    uint256 private constant _BPS = 10_000;
    /// @dev No proposal can be pending this long after its start (voting + execution window).
    uint256 private constant _PENDING_HORIZON = uint256(MAX_PERIOD) * 2;

    ITokenProfileRegistry private immutable _registry;
    address private immutable _poolManager;
    IVotingScheme private _scheme;
    Params private _params;
    uint256 private _proposalCount;

    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 proposalId => IVotingScheme) private _schemeOf;
    mapping(uint256 proposalId => bool) private _closed;
    mapping(uint256 proposalId => mapping(address voter => bool)) private _voted;
    /// @dev Executions of the token at the time the proposal was created.
    mapping(uint256 proposalId => uint256) private _generationOf;

    mapping(address token => uint256[]) private _proposalsOf;
    mapping(address token => uint256) private _executions;

    /// @inheritdoc ITakeoverGovernor
    mapping(address token => uint256) public lastProposalEnd;
    /// @inheritdoc ITakeoverGovernor
    mapping(address token => mapping(address proposer => uint256)) public latestProposalOf;
    /// @inheritdoc ITakeoverGovernor
    mapping(address token => mapping(address proposer => uint256)) public cooldownAnchorOf;

    /// @param initialOwner Admin allowed to change parameters and the scheme, and to cancel
    ///        active proposals.
    /// @param registry_ Token profile registry whose controllers are replaced.
    /// @param scheme_ Initial voting scheme.
    /// @param params_ Initial parameters.
    /// @param poolManager_ Uniswap v4 PoolManager, whose votes are excluded from the circulating
    ///        supply.
    constructor(
        address initialOwner,
        ITokenProfileRegistry registry_,
        IVotingScheme scheme_,
        Params memory params_,
        address poolManager_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || address(scheme_) == address(0)
                || poolManager_ == address(0)
        ) revert ZeroAddress();
        _registry = registry_;
        _scheme = scheme_;
        _poolManager = poolManager_;
        _setParams(params_);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc ITakeoverGovernor
    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    /// @inheritdoc ITakeoverGovernor
    function setScheme(address scheme_) external onlyOwner {
        if (scheme_ == address(0)) revert ZeroAddress();
        _scheme = IVotingScheme(scheme_);
        emit SchemeUpdated(scheme_);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @inheritdoc ITakeoverGovernor
    function propose(address token, address newController) external returns (uint256 proposalId) {
        if (!_registry.isRegistered(token)) revert TokenNotRegistered(token);
        Params memory p = _params;

        uint256 eligibleAt = uint256(_registry.registeredAtOf(token)) + p.minTokenAge;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < eligibleAt) revert TokenTooYoung(token, eligibleAt);

        uint256 previous = latestProposalOf[token][msg.sender];
        if (previous != 0 && _isPending(state(previous))) {
            revert ProposalPending(token, previous);
        }

        uint256 anchor = cooldownAnchorOf[token][msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (anchor != 0 && block.timestamp < anchor + p.cooldown) {
            revert CooldownActive(token, anchor + p.cooldown);
        }

        if (newController == address(0) || newController == _registry.controllerOf(token)) {
            revert InvalidNewController(newController);
        }

        uint48 snapshot = SafeCast.toUint48(block.timestamp - 1);
        uint48 lookbackSnapshot = snapshot - p.lookback;
        uint64 circulatingWeight = _circulatingAt(token, snapshot);
        uint64 weight = _weightAt(token, msg.sender, snapshot, lookbackSnapshot);
        uint64 required =
            SafeCast.toUint64(uint256(circulatingWeight) * p.proposalThresholdBps / _BPS);
        // At least one whole token, even when a small circulating supply rounds the threshold
        // down to zero: an account without voting weight can never propose.
        if (required == 0) required = 1;
        if (weight < required) revert BelowProposalThreshold(weight, required);
        uint64 quorumWeight = SafeCast.toUint64(uint256(circulatingWeight) * p.quorumBps / _BPS);

        uint48 start = SafeCast.toUint48(block.timestamp);
        uint48 end = start + p.votingPeriod;
        uint48 executionDeadline = end + p.executionWindow;

        proposalId = ++_proposalCount;
        _proposals[proposalId] = Proposal({
            token: token,
            proposer: msg.sender,
            newController: newController,
            start: start,
            end: end,
            executionDeadline: executionDeadline,
            snapshot: snapshot,
            executed: false,
            canceled: false,
            quorumWeight: quorumWeight,
            forWeight: 0,
            againstWeight: 0,
            tallied: false,
            lookbackSnapshot: lookbackSnapshot,
            circulatingWeight: circulatingWeight
        });
        _schemeOf[proposalId] = _scheme;
        _generationOf[proposalId] = _executions[token];
        _proposalsOf[token].push(proposalId);
        lastProposalEnd[token] = end;
        latestProposalOf[token][msg.sender] = proposalId;
        cooldownAnchorOf[token][msg.sender] = end;

        _scheme.open(token, proposalId, _OPTION_COUNT);
        emit TakeoverProposed(
            token, proposalId, msg.sender, newController, start, end, quorumWeight
        );
    }

    /// @inheritdoc IBallotGovernor
    /// @dev Called by the proposal's scheme while the voter's `castBallot` transaction executes.
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64 weight)
    {
        Proposal storage p = _proposals[scope];
        if (p.token == address(0)) revert UnknownProposal(scope);
        if (msg.sender != address(_schemeOf[scope])) revert NotScheme(msg.sender);
        if (token != p.token) revert InvalidVote();
        if (state(scope) != State.Active) revert VotingClosed(scope);
        if (_voted[scope][voter]) revert AlreadyVoted(voter);

        weight = _weightAt(token, voter, p.snapshot, p.lookbackSnapshot);
        if (weight == 0) revert InvalidVote();

        _voted[scope][voter] = true;
        emit TakeoverVoteCast(token, scope, ballotRef);
    }

    /// @inheritdoc ITakeoverGovernor
    function closeProposal(uint256 proposalId) external {
        State s = state(proposalId);
        if (s == State.None) revert UnknownProposal(proposalId);
        if (s == State.Active) revert VotingNotEnded(proposalId);
        if (_closed[proposalId]) revert AlreadyClosed(proposalId);
        if (s != State.Closing) revert NotClosable(proposalId, s);

        Proposal storage p = _proposals[proposalId];
        _closed[proposalId] = true;
        _schemeOf[proposalId].requestTally(p.token, proposalId);
        emit TakeoverClosed(p.token, proposalId);
    }

    /// @inheritdoc ITakeoverGovernor
    function recordTally(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (p.token == address(0)) revert UnknownProposal(proposalId);
        if (!_closed[proposalId]) revert NotClosed(proposalId);
        if (p.tallied) revert AlreadyTallied(proposalId);

        (bool isFinal, uint64[] memory counts) =
            _schemeOf[proposalId].tallyOf(address(this), p.token, proposalId);
        if (!isFinal || counts.length != _OPTION_COUNT) revert TallyNotFinal(proposalId);

        p.forWeight = counts[FOR];
        p.againstWeight = counts[AGAINST];
        p.tallied = true;
        emit TakeoverTallied(p.token, proposalId, counts[FOR], counts[AGAINST]);
    }

    /// @inheritdoc ITakeoverGovernor
    function execute(uint256 proposalId) external {
        State s = state(proposalId);
        if (s == State.None) revert UnknownProposal(proposalId);
        if (s != State.Succeeded) revert NotExecutable(proposalId, s);

        Proposal storage p = _proposals[proposalId];
        address token = p.token;
        p.executed = true;
        // Every other proposal of the token created before now becomes Superseded.
        unchecked {
            ++_executions[token];
        }
        _registry.setController(token, p.newController);
        emit TakeoverExecuted(token, proposalId, p.newController);
        emit TakeoverSuperseded(token, proposalId);
    }

    /// @inheritdoc ITakeoverGovernor
    /// @dev Only while voting is open: once the vote has ended no one, the owner included, can
    ///      stop its outcome.
    function cancel(uint256 proposalId) external {
        State s = state(proposalId);
        if (s == State.None) revert UnknownProposal(proposalId);
        Proposal storage p = _proposals[proposalId];
        if (msg.sender != p.proposer && msg.sender != owner()) revert NotProposer();
        if (s != State.Active) revert NotCancelable(proposalId, s);
        p.canceled = true;
        // The proposer's cooldown restarts now rather than at the planned end.
        cooldownAnchorOf[p.token][p.proposer] = block.timestamp;
        emit TakeoverCanceled(p.token, proposalId);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ITakeoverGovernor
    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = _proposals[proposalId];
        if (p.token == address(0)) return State.None;
        if (p.canceled) return State.Canceled;
        if (p.executed) return State.Executed;
        // forge-lint: disable-next-line(block-timestamp)
        bool pastDeadline = block.timestamp > p.executionDeadline;
        State s;
        if (p.tallied) {
            bool passed = p.forWeight >= p.quorumWeight && p.forWeight > p.againstWeight;
            if (!passed) return State.Defeated;
            if (pastDeadline) return State.Expired;
            s = State.Succeeded;
        } else {
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp <= p.end && !_closed[proposalId]) s = State.Active;
            else if (pastDeadline) return State.Expired;
            else s = State.Closing;
        }
        // Still pending, but another proposal of the token was executed after this one was made.
        if (_generationOf[proposalId] != _executions[p.token]) return State.Superseded;
        return s;
    }

    /// @inheritdoc ITakeoverGovernor
    function activeProposalOf(address token) external view returns (uint256) {
        uint256[] storage ids = _proposalsOf[token];
        for (uint256 i = ids.length; i != 0; --i) {
            uint256 id = ids[i - 1];
            if (_pastHorizon(id)) break;
            if (_isPending(state(id))) return id;
        }
        return 0;
    }

    /// @inheritdoc ITakeoverGovernor
    function activeProposalsOf(address token) external view returns (uint256[] memory active) {
        uint256[] storage ids = _proposalsOf[token];
        uint256 n = ids.length;
        uint256 count;
        active = new uint256[](n);
        for (uint256 i = n; i != 0; --i) {
            uint256 id = ids[i - 1];
            if (_pastHorizon(id)) break;
            if (_isPending(state(id))) active[count++] = id;
        }
        // Shrink the array to the entries written.
        assembly ("memory-safe") {
            mstore(active, count)
        }
    }

    /// @inheritdoc ITakeoverGovernor
    function proposalsOf(address token) external view returns (uint256[] memory) {
        return _proposalsOf[token];
    }

    /// @inheritdoc ITakeoverGovernor
    function poolManager() external view returns (address) {
        return _poolManager;
    }

    /// @inheritdoc ITakeoverGovernor
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /// @inheritdoc ITakeoverGovernor
    function proposalCount() external view returns (uint256) {
        return _proposalCount;
    }

    /// @inheritdoc ITakeoverGovernor
    function params() external view returns (Params memory) {
        return _params;
    }

    /// @inheritdoc ITakeoverGovernor
    function scheme() external view returns (address) {
        return address(_scheme);
    }

    /// @inheritdoc ITakeoverGovernor
    function registry() external view returns (address) {
        return address(_registry);
    }

    /// @inheritdoc ITakeoverGovernor
    function proposalScheme(uint256 proposalId) external view returns (address) {
        return address(_schemeOf[proposalId]);
    }

    /// @inheritdoc ITakeoverGovernor
    function isClosed(uint256 proposalId) external view returns (bool) {
        return _closed[proposalId];
    }

    /// @inheritdoc ITakeoverGovernor
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _voted[proposalId][voter];
    }

    /// @inheritdoc ITakeoverGovernor
    function weightOf(uint256 proposalId, address account) external view returns (uint64) {
        Proposal storage p = _proposals[proposalId];
        if (p.token == address(0)) return 0;
        return _weightAt(p.token, account, p.snapshot, p.lookbackSnapshot);
    }

    // ------------------------------------------------------------------ internals

    function _setParams(Params memory p) private {
        if (p.votingPeriod < MIN_PERIOD || p.votingPeriod > MAX_PERIOD) revert InvalidParams();
        if (p.executionWindow < MIN_EXECUTION_WINDOW || p.executionWindow > MAX_PERIOD) {
            revert InvalidParams();
        }
        if (p.cooldown > MAX_COOLDOWN || p.minTokenAge > MAX_TOKEN_AGE) revert InvalidParams();
        if (p.lookback < MIN_LOOKBACK || p.lookback > MAX_LOOKBACK) revert InvalidParams();
        if (
            p.quorumBps < MIN_QUORUM_BPS || p.quorumBps > MAX_QUORUM_BPS
                || p.proposalThresholdBps < MIN_PROPOSAL_THRESHOLD_BPS
                || p.proposalThresholdBps > p.quorumBps
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }

    function _isPending(State s) private pure returns (bool) {
        return s == State.Active || s == State.Closing || s == State.Succeeded;
    }

    /// @dev Whether the proposal started so long ago that it, and every earlier proposal of the
    ///      same token, can no longer be pending.
    function _pastHorizon(uint256 proposalId) private view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return uint256(_proposals[proposalId].start) + _PENDING_HORIZON < block.timestamp;
    }

    /// @dev Voting weight: the smaller of the whole-token checkpoints at `snapshot` and at
    ///      `lookbackSnapshot`, so only votes held through the lookback count.
    function _weightAt(address token, address account, uint48 snapshot, uint48 lookbackSnapshot)
        private
        view
        returns (uint64)
    {
        uint64 atSnapshot = _votesAt(token, account, snapshot);
        uint64 atLookback = _votesAt(token, account, lookbackSnapshot);
        return atSnapshot < atLookback ? atSnapshot : atLookback;
    }

    /// @dev Circulating supply at `snapshot` in whole tokens: total supply minus the PoolManager's
    ///      votes (its balance is self-delegated and can never be cast).
    function _circulatingAt(address token, uint48 snapshot) private view returns (uint64) {
        uint256 total = IVotes(token).getPastTotalSupply(snapshot);
        uint256 pooled = IVotes(token).getPastVotes(_poolManager, snapshot);
        uint256 whole = (total > pooled ? total - pooled : 0) / 1e18;
        // Capped, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
    }

    /// @dev Whole-token vote checkpoint of `account` at `snapshot`, capped to 64 bits; zero while
    ///      the snapshot is not yet in the past.
    function _votesAt(address token, address account, uint48 snapshot)
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
}
