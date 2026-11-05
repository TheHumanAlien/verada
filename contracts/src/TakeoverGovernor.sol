// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ITakeoverGovernor} from "./interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";

/// @title TakeoverGovernor
/// @notice Lets a token's holders replace the controller of its profile. A proposal is a
///         two-option poll (AGAINST / FOR) on the pluggable voting scheme; weights are the
///         token's vote checkpoints at the proposal snapshot, in whole tokens.
/// @dev Timing, quorum and scheme are captured per proposal when it is created, so parameter or
///      scheme changes never affect proposals already running. One proposal per token may be
///      pending (active, closing or awaiting execution) at a time, and a cooldown separates
///      proposals for the same token.
contract TakeoverGovernor is ITakeoverGovernor, IBallotGovernor, Ownable2Step {
    /// @inheritdoc ITakeoverGovernor
    uint8 public constant AGAINST = 0;
    /// @inheritdoc ITakeoverGovernor
    uint8 public constant FOR = 1;

    uint32 public constant MIN_PERIOD = 1 days;
    uint32 public constant MAX_PERIOD = 30 days;
    uint32 public constant MAX_COOLDOWN = 90 days;
    uint32 public constant MAX_TOKEN_AGE = 90 days;
    uint16 public constant MAX_QUORUM_BPS = 5000;

    uint8 private constant _OPTION_COUNT = 2;
    uint256 private constant _BPS = 10_000;

    ITokenProfileRegistry private immutable _registry;
    IVotingScheme private _scheme;
    Params private _params;
    uint256 private _proposalCount;

    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 proposalId => IVotingScheme) private _schemeOf;
    mapping(uint256 proposalId => bool) private _closed;
    mapping(uint256 proposalId => mapping(address voter => bool)) private _voted;

    /// @inheritdoc ITakeoverGovernor
    mapping(address token => uint256) public activeProposalOf;
    /// @inheritdoc ITakeoverGovernor
    mapping(address token => uint256) public lastProposalEnd;

    /// @param initialOwner Admin allowed to change parameters and the scheme, and to cancel.
    /// @param registry_ Token profile registry whose controllers are replaced.
    /// @param scheme_ Initial voting scheme.
    /// @param params_ Initial parameters.
    constructor(
        address initialOwner,
        ITokenProfileRegistry registry_,
        IVotingScheme scheme_,
        Params memory params_
    ) Ownable(initialOwner) {
        if (address(registry_) == address(0) || address(scheme_) == address(0)) {
            revert ZeroAddress();
        }
        _registry = registry_;
        _scheme = scheme_;
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

        uint256 pending = activeProposalOf[token];
        if (pending != 0) {
            State pendingState = state(pending);
            if (
                pendingState == State.Active || pendingState == State.Closing
                    || pendingState == State.Succeeded
            ) revert ProposalPending(token, pending);
        }

        uint256 lastEnd = lastProposalEnd[token];
        // forge-lint: disable-next-line(block-timestamp)
        if (lastEnd != 0 && block.timestamp < lastEnd + p.cooldown) {
            revert CooldownActive(token, lastEnd + p.cooldown);
        }

        if (newController == address(0) || newController == _registry.controllerOf(token)) {
            revert InvalidNewController(newController);
        }

        uint256 supplyWhole = IERC20(token).totalSupply() / 1e18;
        uint48 snapshot = SafeCast.toUint48(block.timestamp - 1);
        uint64 weight = _votesAt(token, msg.sender, snapshot);
        uint64 required = SafeCast.toUint64(supplyWhole * p.proposalThresholdBps / _BPS);
        if (weight < required) revert BelowProposalThreshold(weight, required);
        uint64 quorumWeight = SafeCast.toUint64(supplyWhole * p.quorumBps / _BPS);

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
            tallied: false
        });
        _schemeOf[proposalId] = _scheme;
        activeProposalOf[token] = proposalId;
        lastProposalEnd[token] = end;

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

        weight = _votesAt(token, voter, p.snapshot);
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
        p.executed = true;
        _registry.setController(p.token, p.newController);
        emit TakeoverExecuted(p.token, proposalId, p.newController);
    }

    /// @inheritdoc ITakeoverGovernor
    function cancel(uint256 proposalId) external {
        State s = state(proposalId);
        if (s == State.None) revert UnknownProposal(proposalId);
        Proposal storage p = _proposals[proposalId];
        if (msg.sender == owner()) {
            if (s == State.Executed || s == State.Canceled) revert NotCancelable(proposalId, s);
        } else if (msg.sender == p.proposer) {
            if (s != State.Active) revert NotCancelable(proposalId, s);
        } else {
            revert NotProposer();
        }
        p.canceled = true;
        emit TakeoverCanceled(p.token, proposalId);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ITakeoverGovernor
    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = _proposals[proposalId];
        if (p.token == address(0)) return State.None;
        if (p.canceled) return State.Canceled;
        if (p.executed) return State.Executed;
        if (p.tallied) {
            bool passed = p.forWeight >= p.quorumWeight && p.forWeight > p.againstWeight;
            if (!passed) return State.Defeated;
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp > p.executionDeadline) return State.Expired;
            return State.Succeeded;
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= p.end && !_closed[proposalId]) return State.Active;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > p.executionDeadline) return State.Expired;
        return State.Closing;
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
        return _votesAt(p.token, account, p.snapshot);
    }

    // ------------------------------------------------------------------ internals

    function _setParams(Params memory p) private {
        if (p.votingPeriod < MIN_PERIOD || p.votingPeriod > MAX_PERIOD) revert InvalidParams();
        if (p.executionWindow < MIN_PERIOD || p.executionWindow > MAX_PERIOD) {
            revert InvalidParams();
        }
        if (p.cooldown > MAX_COOLDOWN || p.minTokenAge > MAX_TOKEN_AGE) revert InvalidParams();
        if (p.quorumBps > MAX_QUORUM_BPS || p.proposalThresholdBps > p.quorumBps) {
            revert InvalidParams();
        }
        _params = p;
        emit ParamsUpdated(p);
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
