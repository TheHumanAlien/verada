// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {TakeoverGovernor} from "../src/TakeoverGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ITakeoverGovernor} from "../src/interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";

contract TakeoverGovernorTest is Test {
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant WHOLE = 1e18;
    uint256 internal constant SUPPLY_WHOLE = 100_000_000_000;
    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;

    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    TakeoverGovernor internal gov;
    VeradaToken internal tokenContract;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal proposer = makeAddr("proposer"); // 2%
    address internal whale = makeAddr("whale"); // 10%
    address internal mid = makeAddr("mid"); // 5%
    address internal small = makeAddr("small"); // 0.5%
    address internal dust = makeAddr("dust"); // < 1 token
    address internal nobody = makeAddr("nobody");
    address internal newController = makeAddr("newController");
    address internal poolManager = makeAddr("poolManager");

    ITakeoverGovernor.Params internal P = ITakeoverGovernor.Params({
        votingPeriod: 3 days,
        executionWindow: 7 days,
        cooldown: 14 days,
        minTokenAge: 2 days,
        quorumBps: 1000,
        proposalThresholdBps: 100,
        lookback: 1 days
    });

    function setUp() public {
        vm.warp(T0);
        tokenContract = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        _give(proposer, 2_000_000_000 * WHOLE);
        _give(whale, 10_000_000_000 * WHOLE);
        _give(mid, 5_000_000_000 * WHOLE);
        _give(small, 500_000_000 * WHOLE);
        _give(dust, WHOLE - 1);

        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        profiles.register(token, creator);
        gov = new TakeoverGovernor(
            owner, ITokenProfileRegistry(address(profiles)), scheme, P, poolManager
        );
        scheme.setGovernor(address(gov), true);
        profiles.setGovernor(address(gov));

        // Past the minimum token age, with every balance strictly before any snapshot.
        vm.warp(T0 + 2 days);
    }

    // ---- helpers

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        tokenContract.transfer(to, amount);
    }

    function _propose() internal returns (uint256 id) {
        vm.prank(proposer);
        id = gov.propose(token, newController);
    }

    function _vote(uint256 id, address voter, uint8 choice) internal returns (bytes32) {
        vm.prank(voter);
        return scheme.castBallot(address(gov), token, id, abi.encode(choice));
    }

    function _ref(uint256 id, address voter) internal view returns (bytes32) {
        return keccak256(abi.encode(address(gov), token, id, voter));
    }

    function _end(uint256 id) internal view returns (uint256) {
        return gov.getProposal(id).end;
    }

    function _deadline(uint256 id) internal view returns (uint256) {
        return gov.getProposal(id).executionDeadline;
    }

    /// @dev Proposal with FOR > quorum, closed and tallied: state Succeeded.
    function _succeeded() internal returns (uint256 id) {
        id = _propose();
        _vote(id, whale, FOR);
        _vote(id, mid, AGAINST);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        assertEq(uint8(gov.state(id)), uint8(ITakeoverGovernor.State.Succeeded));
    }

    function _assertState(uint256 id, ITakeoverGovernor.State s) internal view {
        assertEq(uint8(gov.state(id)), uint8(s));
    }

    // ---- construction / params

    function test_constructor_storesConfig() public view {
        assertEq(gov.owner(), owner);
        assertEq(gov.registry(), address(profiles));
        assertEq(gov.scheme(), address(scheme));
        assertEq(gov.AGAINST(), AGAINST);
        assertEq(gov.FOR(), FOR);
        assertEq(gov.proposalCount(), 0);
        assertEq(gov.poolManager(), poolManager);
        assertEq(gov.MIN_EXECUTION_WINDOW(), 2 days);
        assertEq(gov.MIN_QUORUM_BPS(), 50);
        assertEq(gov.MIN_LOOKBACK(), 1 days);
        assertEq(gov.MAX_LOOKBACK(), 90 days);
        ITakeoverGovernor.Params memory p = gov.params();
        assertEq(p.votingPeriod, 3 days);
        assertEq(p.executionWindow, 7 days);
        assertEq(p.cooldown, 14 days);
        assertEq(p.minTokenAge, 2 days);
        assertEq(p.quorumBps, 1000);
        assertEq(p.proposalThresholdBps, 100);
        assertEq(p.lookback, 1 days);
    }

    function test_constructor_zeroAddressReverts() public {
        vm.expectRevert(ITakeoverGovernor.ZeroAddress.selector);
        new TakeoverGovernor(owner, ITokenProfileRegistry(address(0)), scheme, P, poolManager);
        vm.expectRevert(ITakeoverGovernor.ZeroAddress.selector);
        new TakeoverGovernor(
            owner,
            ITokenProfileRegistry(address(profiles)),
            IVotingScheme(address(0)),
            P,
            poolManager
        );
        vm.expectRevert(ITakeoverGovernor.ZeroAddress.selector);
        new TakeoverGovernor(owner, ITokenProfileRegistry(address(profiles)), scheme, P, address(0));
    }

    function test_constructor_invalidParamsReverts() public {
        ITakeoverGovernor.Params memory bad = P;
        bad.quorumBps = 5001;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        new TakeoverGovernor(
            owner, ITokenProfileRegistry(address(profiles)), scheme, bad, poolManager
        );
    }

    function test_setParams_onlyOwner_andEmits() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setParams(P);
        ITakeoverGovernor.Params memory q = P;
        q.votingPeriod = 5 days;
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit ITakeoverGovernor.ParamsUpdated(q);
        gov.setParams(q);
        assertEq(gov.params().votingPeriod, 5 days);
    }

    function test_setParams_bounds() public {
        vm.startPrank(owner);
        ITakeoverGovernor.Params memory q;

        q = P;
        q.votingPeriod = 1 days - 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.votingPeriod = 30 days + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.votingPeriod = 1 days;
        gov.setParams(q);
        q.votingPeriod = 30 days;
        gov.setParams(q);

        q = P;
        q.executionWindow = 2 days - 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.executionWindow = 2 days;
        gov.setParams(q);
        q.executionWindow = 30 days + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.executionWindow = 30 days;
        gov.setParams(q);

        q = P;
        q.cooldown = 90 days + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.cooldown = 90 days;
        gov.setParams(q);
        q.cooldown = 0;
        gov.setParams(q);

        q = P;
        q.minTokenAge = 90 days + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.minTokenAge = 90 days;
        gov.setParams(q);

        q = P;
        q.lookback = 1 days - 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.lookback = 90 days + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.lookback = 1 days;
        gov.setParams(q);
        q.lookback = 90 days;
        gov.setParams(q);

        q = P;
        q.quorumBps = 5001;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.quorumBps = 5000;
        gov.setParams(q);
        q.quorumBps = 49;
        q.proposalThresholdBps = 0;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.quorumBps = 0;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);

        q = P;
        q.proposalThresholdBps = q.quorumBps + 1;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.proposalThresholdBps = q.quorumBps;
        gov.setParams(q);
        q.quorumBps = 50;
        q.proposalThresholdBps = 0;
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);
        q.proposalThresholdBps = 1;
        gov.setParams(q);
        vm.stopPrank();
    }

    function test_setScheme_onlyOwner_zeroCheck_emits() public {
        MockVotingScheme s2 = new MockVotingScheme();
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setScheme(address(s2));
        vm.startPrank(owner);
        vm.expectRevert(ITakeoverGovernor.ZeroAddress.selector);
        gov.setScheme(address(0));
        vm.expectEmit(true, false, false, true);
        emit ITakeoverGovernor.SchemeUpdated(address(s2));
        gov.setScheme(address(s2));
        vm.stopPrank();
        assertEq(gov.scheme(), address(s2));
    }

    // ---- propose

    function test_propose_success() public {
        uint48 start = uint48(block.timestamp);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.PollOpened(address(gov), token, 1, 2);
        vm.expectEmit(true, true, true, true);
        emit ITakeoverGovernor.TakeoverProposed(
            token, 1, proposer, newController, start, start + 3 days, 10_000_000_000
        );
        uint256 id = _propose();

        assertEq(id, 1);
        assertEq(gov.proposalCount(), 1);
        assertEq(gov.activeProposalOf(token), 1);
        assertEq(gov.activeProposalsOf(token).length, 1);
        assertEq(gov.proposalsOf(token).length, 1);
        assertEq(gov.lastProposalEnd(token), start + 3 days);
        assertEq(gov.latestProposalOf(token, proposer), 1);
        assertEq(gov.cooldownAnchorOf(token, proposer), start + 3 days);
        assertEq(gov.proposalScheme(id), address(scheme));
        assertFalse(gov.isClosed(id));
        _assertState(id, ITakeoverGovernor.State.Active);
        assertTrue(scheme.isOpen(address(gov), token, id));
        assertEq(scheme.optionCountOf(address(gov), token, id), 2);

        ITakeoverGovernor.Proposal memory p = gov.getProposal(id);
        assertEq(p.token, token);
        assertEq(p.proposer, proposer);
        assertEq(p.newController, newController);
        assertEq(p.start, start);
        assertEq(p.end, start + 3 days);
        assertEq(p.executionDeadline, start + 10 days);
        assertEq(p.snapshot, start - 1);
        assertEq(p.lookbackSnapshot, start - 1 - 1 days);
        assertEq(p.circulatingWeight, SUPPLY_WHOLE);
        assertEq(p.quorumWeight, SUPPLY_WHOLE * 1000 / 10_000);
        assertFalse(p.executed);
        assertFalse(p.canceled);
        assertFalse(p.tallied);
        assertEq(p.forWeight, 0);
        assertEq(p.againstWeight, 0);
    }

    function test_propose_unregisteredToken() public {
        address other = makeAddr("other");
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.TokenNotRegistered.selector, other)
        );
        gov.propose(other, newController);
    }

    function test_propose_tokenTooYoung() public {
        vm.warp(T0 + 2 days - 1);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.TokenTooYoung.selector, token, T0 + 2 days)
        );
        gov.propose(token, newController);
        vm.warp(T0 + 2 days);
        _propose();
    }

    function test_propose_invalidNewController() public {
        vm.startPrank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.InvalidNewController.selector, address(0))
        );
        gov.propose(token, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.InvalidNewController.selector, creator)
        );
        gov.propose(token, creator);
        vm.stopPrank();
    }

    function test_propose_belowThreshold() public {
        uint64 required = uint64(SUPPLY_WHOLE * 100 / 10_000);
        vm.prank(small);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.BelowProposalThreshold.selector, uint64(500_000_000), required
            )
        );
        gov.propose(token, newController);
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, newController);
    }

    function test_propose_exactThresholdPasses() public {
        address exact = makeAddr("exact");
        _give(exact, 1_000_000_000 * WHOLE);
        // Held through the whole lookback.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(exact);
        gov.propose(token, newController);
    }

    function test_propose_tokensReceivedNowDoNotCount() public {
        // Funded in this very second: the snapshot is one second earlier.
        _give(nobody, 5_000_000_000 * WHOLE);
        uint64 required = uint64(SUPPLY_WHOLE * 100 / 10_000);
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, newController);
    }

    function test_propose_pendingProposalBlocksSameProposerOnly() public {
        uint256 id = _propose();
        // The proposer's own proposal is Active: blocked.
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.ProposalPending.selector, token, id)
        );
        gov.propose(token, makeAddr("other"));
        // Another holder may propose concurrently.
        vm.prank(whale);
        uint256 id2 = gov.propose(token, makeAddr("other"));
        assertEq(id2, 2);
        _assertState(id, ITakeoverGovernor.State.Active);
        _assertState(id2, ITakeoverGovernor.State.Active);
        assertEq(gov.activeProposalOf(token), id2);
        uint256[] memory active = gov.activeProposalsOf(token);
        assertEq(active.length, 2);
        assertEq(active[0], id2);
        assertEq(active[1], id);

        // Closing (ended, not tallied) and closed-but-not-tallied still block the proposer; the
        // cooldown of zero shows the pending check alone does it.
        ITakeoverGovernor.Params memory q = P;
        q.cooldown = 0;
        vm.prank(owner);
        gov.setParams(q);
        vm.warp(_end(id) + 1);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.ProposalPending.selector, token, id)
        );
        gov.propose(token, newController);
        gov.closeProposal(id);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.ProposalPending.selector, token, id)
        );
        gov.propose(token, newController);
    }

    function test_propose_succeededBlocksProposer_untilExpired_thenCooldown() public {
        uint256 id = _succeeded();
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.ProposalPending.selector, token, id)
        );
        gov.propose(token, makeAddr("another"));
        vm.warp(_end(id) + gov.params().cooldown + 1);
        // Past the 7-day execution window -> Expired; past the proposer's cooldown: allowed.
        _assertState(id, ITakeoverGovernor.State.Expired);
        assertEq(gov.activeProposalOf(token), 0);
        vm.prank(proposer);
        uint256 id2 = gov.propose(token, newController);
        assertEq(id2, 2);
        assertEq(gov.activeProposalOf(token), 2);
    }

    function test_propose_cooldownIsPerProposer() public {
        uint256 id = _propose();
        _vote(id, mid, AGAINST);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Defeated);

        uint256 availableAt = _end(id) + gov.params().cooldown;
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.CooldownActive.selector, token, availableAt)
        );
        gov.propose(token, newController);
        // Other holders are not affected by the proposer's cooldown.
        vm.prank(whale);
        assertEq(gov.propose(token, newController), 2);

        vm.warp(availableAt - 1);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.CooldownActive.selector, token, availableAt)
        );
        gov.propose(token, newController);
        vm.warp(availableAt);
        vm.prank(proposer);
        assertEq(gov.propose(token, newController), 3);
    }

    function test_propose_cooldownAfterCancel_countsFromCancel() public {
        uint256 id = _propose();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(proposer);
        gov.cancel(id);
        assertEq(gov.cooldownAnchorOf(token, proposer), block.timestamp);
        uint256 availableAt = block.timestamp + gov.params().cooldown;
        assertLt(availableAt, _end(id) + gov.params().cooldown);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.CooldownActive.selector, token, availableAt)
        );
        gov.propose(token, newController);
        // Nobody else is locked out by the cancel.
        vm.prank(whale);
        gov.propose(token, newController);
        vm.warp(availableAt);
        vm.prank(proposer);
        gov.propose(token, newController);
    }

    function test_propose_cooldownAfterExecution() public {
        uint256 id = _succeeded();
        gov.execute(id);
        uint256 availableAt = _end(id) + gov.params().cooldown;
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.CooldownActive.selector, token, availableAt)
        );
        gov.propose(token, makeAddr("another"));
        vm.prank(whale);
        gov.propose(token, makeAddr("another"));
    }

    function test_propose_independentTokens() public {
        VeradaToken t2 = new VeradaToken("Two", "TWO", "ipfs://2", creator, factory);
        vm.prank(factory);
        t2.transfer(proposer, 5_000_000_000 * WHOLE);
        profiles.register(address(t2), creator);
        vm.warp(block.timestamp + 2 days);
        _propose();
        vm.prank(proposer);
        uint256 id2 = gov.propose(address(t2), newController);
        assertEq(id2, 2);
        assertEq(gov.activeProposalOf(address(t2)), 2);
        assertEq(gov.activeProposalOf(token), 1);
    }

    // ---- ballots

    function test_weightOf() public {
        uint256 id = _propose();
        assertEq(gov.weightOf(id, whale), 10_000_000_000);
        assertEq(gov.weightOf(id, proposer), 2_000_000_000);
        assertEq(gov.weightOf(id, dust), 0);
        assertEq(gov.weightOf(id, nobody), 0);
        assertEq(gov.weightOf(99, whale), 0);
    }

    function test_castBallot_recordsAndEmits() public {
        uint256 id = _propose();
        bytes32 ref = _ref(id, whale);
        vm.expectEmit(true, true, false, true);
        emit ITakeoverGovernor.TakeoverVoteCast(token, id, ref);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.BallotCast(address(gov), token, id, whale, 10_000_000_000, ref);
        assertEq(_vote(id, whale, FOR), ref);
        assertTrue(gov.hasVoted(id, whale));
        assertFalse(gov.hasVoted(id, mid));
        uint64[] memory live = scheme.liveCounts(address(gov), token, id);
        assertEq(live[FOR], 10_000_000_000);
        assertEq(live[AGAINST], 0);
    }

    function test_authorizeBallot_onlyScheme() public {
        uint256 id = _propose();
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.NotScheme.selector, nobody));
        gov.authorizeBallot(token, id, whale, bytes32(0));
        // The current scheme is not this proposal's scheme once swapped.
        MockVotingScheme s2 = new MockVotingScheme();
        vm.prank(owner);
        gov.setScheme(address(s2));
        vm.prank(address(s2));
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.NotScheme.selector, address(s2)));
        gov.authorizeBallot(token, id, whale, bytes32(0));
    }

    function test_authorizeBallot_unknownProposal() public {
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 7));
        gov.authorizeBallot(token, 7, whale, bytes32(0));
    }

    function test_castBallot_wrongTokenReverts() public {
        uint256 id = _propose();
        vm.prank(whale);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), makeAddr("other"), id, abi.encode(FOR));
    }

    function test_castBallot_zeroWeightReverts() public {
        uint256 id = _propose();
        vm.prank(dust);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
        vm.prank(nobody);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
    }

    function test_castBallot_doubleVoteReverts() public {
        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.AlreadyVoted.selector, whale));
        scheme.castBallot(address(gov), token, id, abi.encode(AGAINST));
    }

    function test_castBallot_windowEdges() public {
        uint256 id = _propose();
        vm.warp(_end(id));
        _vote(id, whale, FOR); // last second is still active
        vm.warp(_end(id) + 1);
        vm.prank(mid);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.VotingClosed.selector, id));
        scheme.castBallot(address(gov), token, id, abi.encode(AGAINST));
    }

    function test_castBallot_afterCancelReverts() public {
        uint256 id = _propose();
        vm.prank(proposer);
        gov.cancel(id);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.VotingClosed.selector, id));
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
    }

    function test_castBallot_snapshotImmuneToTransfers() public {
        uint256 id = _propose();
        // whale dumps to nobody after the snapshot: whale keeps its weight, nobody has none.
        vm.prank(whale);
        tokenContract.transfer(nobody, 10_000_000_000 * WHOLE);
        vm.warp(block.timestamp + 1);
        assertEq(gov.weightOf(id, whale), 10_000_000_000);
        assertEq(gov.weightOf(id, nobody), 0);
        _vote(id, whale, FOR);
        vm.prank(nobody);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
    }

    function test_castBallot_invalidChoiceRejectedByScheme() public {
        uint256 id = _propose();
        vm.prank(whale);
        vm.expectRevert(IVotingScheme.InvalidBallot.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(uint8(2)));
        assertFalse(gov.hasVoted(id, whale));
    }

    // ---- close / tally

    function test_closeProposal_timing_andEmits() public {
        uint256 id = _propose();
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.VotingNotEnded.selector, id));
        gov.closeProposal(id);
        vm.warp(_end(id));
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.VotingNotEnded.selector, id));
        gov.closeProposal(id);
        vm.warp(_end(id) + 1);
        _assertState(id, ITakeoverGovernor.State.Closing);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.TallyRequested(address(gov), token, id);
        vm.expectEmit(true, true, false, true);
        emit ITakeoverGovernor.TakeoverClosed(token, id);
        vm.prank(nobody);
        gov.closeProposal(id);
        assertTrue(gov.isClosed(id));
        assertTrue(scheme.isClosed(address(gov), token, id));
        _assertState(id, ITakeoverGovernor.State.Closing);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.AlreadyClosed.selector, id));
        gov.closeProposal(id);
    }

    function test_closeProposal_unknown_canceled_expired() public {
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 1));
        gov.closeProposal(1);

        uint256 id = _propose();
        vm.prank(proposer);
        gov.cancel(id);
        vm.warp(_end(id) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotClosable.selector, id, ITakeoverGovernor.State.Canceled
            )
        );
        gov.closeProposal(id);

        vm.prank(whale);
        uint256 id2 = gov.propose(token, newController);
        vm.warp(_deadline(id2) + 1);
        _assertState(id2, ITakeoverGovernor.State.Expired);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotClosable.selector, id2, ITakeoverGovernor.State.Expired
            )
        );
        gov.closeProposal(id2);
    }

    function test_recordTally_guards() public {
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 3));
        gov.recordTally(3);

        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.NotClosed.selector, id));
        gov.recordTally(id);
        vm.warp(_end(id) + 1);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.NotClosed.selector, id));
        gov.recordTally(id);
        gov.closeProposal(id);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.TallyNotFinal.selector, id));
        gov.recordTally(id);

        // A malformed tally is not accepted.
        uint64[] memory bad = new uint64[](3);
        scheme.submitTally(address(gov), token, id, abi.encode(bad), "");
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.TallyNotFinal.selector, id));
        gov.recordTally(id);
    }

    function test_recordTally_storesAndEmits() public {
        uint256 id = _propose();
        _vote(id, whale, FOR);
        _vote(id, mid, AGAINST);
        _vote(id, proposer, FOR);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);

        vm.expectEmit(true, true, false, true);
        emit ITakeoverGovernor.TakeoverTallied(token, id, 12_000_000_000, 5_000_000_000);
        vm.prank(nobody);
        gov.recordTally(id);

        ITakeoverGovernor.Proposal memory p = gov.getProposal(id);
        assertTrue(p.tallied);
        assertEq(p.forWeight, 12_000_000_000);
        assertEq(p.againstWeight, 5_000_000_000);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.AlreadyTallied.selector, id));
        gov.recordTally(id);
    }

    function test_outcome_quorumEdges() public {
        // Exactly the quorum (10% = whale) with no AGAINST: succeeds.
        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
    }

    function test_outcome_belowQuorumDefeated() public {
        uint256 id = _propose();
        _vote(id, mid, FOR); // 5% < 10%
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Defeated);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Defeated
            )
        );
        gov.execute(id);
    }

    function test_outcome_tieDefeated() public {
        uint256 id = _propose();
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        uint64[] memory counts = new uint64[](2);
        counts[0] = 10_000_000_000;
        counts[1] = 10_000_000_000;
        scheme.submitTally(address(gov), token, id, abi.encode(counts), "");
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Defeated);
    }

    function test_outcome_moreAgainstDefeated() public {
        uint256 id = _propose();
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        uint64[] memory counts = new uint64[](2);
        counts[AGAINST] = 12_000_000_000;
        counts[FOR] = 11_000_000_000;
        scheme.submitTally(address(gov), token, id, abi.encode(counts), "");
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Defeated);
    }

    // ---- execute

    function test_execute_replacesController() public {
        uint256 id = _succeeded();
        assertEq(profiles.controllerOf(token), creator);
        vm.expectEmit(true, true, true, true);
        emit ITakeoverGovernor.TakeoverExecuted(token, id, newController);
        vm.prank(nobody);
        gov.execute(id);

        assertEq(profiles.controllerOf(token), newController);
        assertEq(profiles.setControllerCalls(), 1);
        assertEq(profiles.lastSetControllerToken(), token);
        assertEq(profiles.lastSetControllerAccount(), newController);
        assertEq(profiles.lastSetControllerCaller(), address(gov));
        assertTrue(gov.getProposal(id).executed);
        _assertState(id, ITakeoverGovernor.State.Executed);

        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Executed
            )
        );
        gov.execute(id);
    }

    function test_execute_windowEdges() public {
        uint256 id = _succeeded();
        vm.warp(_deadline(id));
        _assertState(id, ITakeoverGovernor.State.Succeeded);
        vm.warp(_deadline(id) + 1);
        _assertState(id, ITakeoverGovernor.State.Expired);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Expired
            )
        );
        gov.execute(id);
        assertEq(profiles.setControllerCalls(), 0);
    }

    function test_execute_atDeadlineSucceeds() public {
        uint256 id = _succeeded();
        vm.warp(_deadline(id));
        gov.execute(id);
        assertEq(profiles.controllerOf(token), newController);
    }

    function test_execute_wrongStates() public {
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 1));
        gov.execute(1);

        uint256 id = _propose();
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Active
            )
        );
        gov.execute(id);
        vm.warp(_end(id) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Closing
            )
        );
        gov.execute(id);
    }

    function test_expired_withoutTally() public {
        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.warp(_deadline(id) + 1);
        _assertState(id, ITakeoverGovernor.State.Expired);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, id, ITakeoverGovernor.State.Expired
            )
        );
        gov.execute(id);
    }

    function test_registryGateIsRespected() public {
        // If the registry stops trusting this governor, execution reverts and nothing is marked.
        uint256 id = _succeeded();
        profiles.setGovernor(makeAddr("someoneElse"));
        vm.expectRevert(MockProfileRegistryLite.NotGovernor.selector);
        gov.execute(id);
        assertFalse(gov.getProposal(id).executed);
    }

    // ---- cancel

    function test_cancel_byProposerWhileActive() public {
        uint256 id = _propose();
        vm.expectEmit(true, true, false, true);
        emit ITakeoverGovernor.TakeoverCanceled(token, id);
        vm.prank(proposer);
        gov.cancel(id);
        _assertState(id, ITakeoverGovernor.State.Canceled);
        assertTrue(gov.getProposal(id).canceled);
    }

    function test_cancel_byProposerAfterEndReverts() public {
        uint256 id = _propose();
        vm.warp(_end(id) + 1);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Closing
            )
        );
        gov.cancel(id);
    }

    function test_cancel_byStranger_andUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 1));
        gov.cancel(1);
        uint256 id = _propose();
        vm.prank(nobody);
        vm.expectRevert(ITakeoverGovernor.NotProposer.selector);
        gov.cancel(id);
    }

    function test_cancel_byOwnerWhileActive() public {
        uint256 id = _propose();
        vm.prank(owner);
        gov.cancel(id);
        _assertState(id, ITakeoverGovernor.State.Canceled);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Canceled
            )
        );
        gov.cancel(id);
    }

    /// L-3: the owner has no veto over a vote that has ended.
    function test_cancel_byOwnerAfterVoteEndsReverts() public {
        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.warp(_end(id) + 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Closing
            )
        );
        gov.cancel(id);
        gov.closeProposal(id);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Closing
            )
        );
        gov.cancel(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Succeeded
            )
        );
        gov.cancel(id);
        gov.execute(id);
        assertEq(profiles.controllerOf(token), newController);
    }

    function test_cancel_byOwnerAfterExecutionReverts() public {
        uint256 id = _succeeded();
        gov.execute(id);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, id, ITakeoverGovernor.State.Executed
            )
        );
        gov.cancel(id);
    }

    // ---- parameter / scheme snapshots

    function test_setParams_doesNotAffectRunningProposal() public {
        uint256 id = _propose();
        ITakeoverGovernor.Proposal memory before_ = gov.getProposal(id);

        ITakeoverGovernor.Params memory q = P;
        q.votingPeriod = 10 days;
        q.executionWindow = 2 days;
        q.quorumBps = 4000;
        q.proposalThresholdBps = 4000;
        vm.prank(owner);
        gov.setParams(q);

        ITakeoverGovernor.Proposal memory after_ = gov.getProposal(id);
        assertEq(after_.end, before_.end);
        assertEq(after_.executionDeadline, before_.executionDeadline);
        assertEq(after_.quorumWeight, before_.quorumWeight);

        // The running proposal still succeeds with the old quorum.
        _vote(id, whale, FOR);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);

        // A new proposal uses the new params (threshold 40% now blocks the proposer).
        vm.warp(_end(id) + gov.params().cooldown + 1);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.BelowProposalThreshold.selector,
                uint64(2_000_000_000),
                uint64(SUPPLY_WHOLE * 4000 / 10_000)
            )
        );
        gov.propose(token, newController);
    }

    function test_setScheme_onlyAffectsFutureProposals() public {
        uint256 id = _propose();
        MockVotingScheme s2 = new MockVotingScheme();
        s2.setGovernor(address(gov), true);
        vm.prank(owner);
        gov.setScheme(address(s2));

        assertEq(gov.proposalScheme(id), address(scheme));
        _vote(id, whale, FOR);
        vm.prank(mid);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.NotScheme.selector, address(s2)));
        s2.castBallot(address(gov), token, id, abi.encode(AGAINST));

        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        assertTrue(scheme.isClosed(address(gov), token, id));
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        gov.execute(id);

        vm.warp(_end(id) + gov.params().cooldown);
        vm.prank(whale);
        uint256 id2 = gov.propose(token, makeAddr("third"));
        assertEq(gov.proposalScheme(id2), address(s2));
        assertTrue(s2.isOpen(address(gov), token, id2));
        vm.prank(mid);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.NotScheme.selector, address(scheme))
        );
        scheme.castBallot(address(gov), token, id2, abi.encode(FOR));
        vm.prank(mid);
        s2.castBallot(address(gov), token, id2, abi.encode(FOR));
        assertTrue(gov.hasVoted(id2, mid));
    }

    // ---- security regressions

    /// H-1 (ported PoC): propose + immediate cancel, even by the incumbent controller, no longer
    /// locks other holders out; the griefer only puts itself in cooldown.
    function test_proposeCancelGrief_doesNotLockOutOthers() public {
        _give(creator, 2_000_000_000 * WHOLE);
        vm.warp(block.timestamp + 1 days + 1);
        vm.startPrank(creator);
        uint256 id = gov.propose(token, nobody);
        gov.cancel(id);
        vm.stopPrank();

        vm.prank(whale);
        uint256 id2 = gov.propose(token, newController);
        _assertState(id2, ITakeoverGovernor.State.Active);
        assertEq(gov.activeProposalOf(token), id2);

        uint256 availableAt = block.timestamp + gov.params().cooldown;
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.CooldownActive.selector, token, availableAt)
        );
        gov.propose(token, nobody);
    }

    /// H-1: proposals run concurrently; executing one supersedes every older one of the token.
    function test_concurrentProposals_executionSupersedesOthers() public {
        address junk = makeAddr("junk");
        address third = makeAddr("third");
        vm.prank(proposer);
        uint256 a = gov.propose(token, junk);
        vm.prank(mid);
        uint256 b = gov.propose(token, newController);
        vm.warp(block.timestamp + 1 days);
        vm.prank(whale);
        uint256 c = gov.propose(token, third);
        assertEq(gov.activeProposalsOf(token).length, 3);
        assertEq(gov.activeProposalOf(token), c);

        _vote(b, whale, FOR);
        _vote(a, small, FOR);
        vm.warp(_end(b) + 1);
        _assertState(c, ITakeoverGovernor.State.Active);
        gov.closeProposal(a);
        scheme.finalizeFromBallots(address(gov), token, a);
        gov.recordTally(a);
        _assertState(a, ITakeoverGovernor.State.Defeated);
        gov.closeProposal(b);
        scheme.finalizeFromBallots(address(gov), token, b);
        gov.recordTally(b);
        _assertState(b, ITakeoverGovernor.State.Succeeded);

        vm.expectEmit(true, true, true, true);
        emit ITakeoverGovernor.TakeoverExecuted(token, b, newController);
        vm.expectEmit(true, true, false, true);
        emit ITakeoverGovernor.TakeoverSuperseded(token, b);
        gov.execute(b);
        assertEq(profiles.controllerOf(token), newController);

        // The still-running proposal is dead: no ballots, no close, no cancel, no execution.
        _assertState(c, ITakeoverGovernor.State.Superseded);
        _assertState(a, ITakeoverGovernor.State.Defeated);
        _assertState(b, ITakeoverGovernor.State.Executed);
        assertEq(gov.activeProposalsOf(token).length, 0);
        assertEq(gov.activeProposalOf(token), 0);
        vm.prank(mid);
        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.VotingClosed.selector, c));
        scheme.castBallot(address(gov), token, c, abi.encode(FOR));
        vm.prank(whale);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotCancelable.selector, c, ITakeoverGovernor.State.Superseded
            )
        );
        gov.cancel(c);
        vm.warp(_end(c) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotClosable.selector, c, ITakeoverGovernor.State.Superseded
            )
        );
        gov.closeProposal(c);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, c, ITakeoverGovernor.State.Superseded
            )
        );
        gov.execute(c);
        // The whale's superseded proposal no longer blocks it (its cooldown still applies).
        vm.warp(_end(c) + gov.params().cooldown);
        vm.prank(whale);
        uint256 d = gov.propose(token, third);
        _assertState(d, ITakeoverGovernor.State.Active);
    }

    /// A Succeeded proposal is superseded too, and proposals made after the execution are not.
    function test_execution_supersedesSucceeded_notLaterProposals() public {
        vm.prank(proposer);
        uint256 a = gov.propose(token, newController);
        vm.prank(mid);
        uint256 b = gov.propose(token, makeAddr("other"));
        _vote(a, whale, FOR);
        _vote(b, whale, FOR);
        vm.warp(_end(a) + 1);
        for (uint256 id = a; id <= b; ++id) {
            gov.closeProposal(id);
            scheme.finalizeFromBallots(address(gov), token, id);
            gov.recordTally(id);
            _assertState(id, ITakeoverGovernor.State.Succeeded);
        }
        gov.execute(a);
        _assertState(b, ITakeoverGovernor.State.Superseded);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITakeoverGovernor.NotExecutable.selector, b, ITakeoverGovernor.State.Superseded
            )
        );
        gov.execute(b);

        vm.prank(whale);
        uint256 c = gov.propose(token, makeAddr("later"));
        _assertState(c, ITakeoverGovernor.State.Active);
    }

    /// The incumbent handing the profile to another of its accounts does not void a running
    /// takeover: the vote still decides who controls the profile.
    function test_controllerHandoverByIncumbent_doesNotSupersede() public {
        uint256 id = _propose();
        _vote(id, whale, FOR);
        vm.prank(creator);
        profiles.setController(token, makeAddr("sockpuppet"));
        _assertState(id, ITakeoverGovernor.State.Active);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        gov.execute(id);
        assertEq(profiles.controllerOf(token), newController);
    }

    /// M-1 (ported PoC): votes bought for the proposal (buy, propose, vote, sell) count nothing.
    function test_voteRental_rejected() public {
        address attacker = makeAddr("attacker");
        _give(attacker, 15_000_000_000 * WHOLE); // 15%, above quorum, bought just now
        vm.warp(block.timestamp + 12);
        uint64 required = uint64(SUPPLY_WHOLE * 100 / 10_000);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, attacker);

        // On an honest proposal the rented votes weigh nothing either.
        uint256 id = _propose();
        assertEq(gov.weightOf(id, attacker), 0);
        vm.prank(attacker);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
    }

    /// M-1: weight is the smaller of the checkpoints at the snapshot and the lookback snapshot.
    function test_weight_isMinOfSnapshotAndLookback() public {
        _give(mid, 5_000_000_000 * WHOLE); // mid tops up inside the lookback
        vm.prank(whale);
        tokenContract.transfer(nobody, 5_000_000_000 * WHOLE); // whale sells half
        vm.warp(block.timestamp + 2 hours);
        uint256 id = _propose();
        assertEq(gov.weightOf(id, mid), 5_000_000_000);
        assertEq(gov.weightOf(id, whale), 5_000_000_000);
        assertEq(gov.weightOf(id, nobody), 0);
        _vote(id, mid, FOR);
        assertEq(scheme.liveCounts(address(gov), token, id)[FOR], 5_000_000_000);
    }

    /// M-2: quorum and threshold are fractions of the circulating supply, which excludes the
    /// PoolManager's (never-voting) balance.
    function test_quorumAndThreshold_excludePoolManager() public {
        uint256 pooled = tokenContract.balanceOf(factory);
        vm.prank(factory);
        tokenContract.transfer(poolManager, pooled);
        vm.warp(block.timestamp + 1 days + 1);
        uint64 circulating = uint64((tokenContract.totalSupply() - pooled) / WHOLE);

        // 0.5% of the supply is above 1% of the circulating supply.
        vm.prank(small);
        uint256 id = gov.propose(token, newController);
        ITakeoverGovernor.Proposal memory p = gov.getProposal(id);
        assertEq(p.circulatingWeight, circulating);
        assertEq(p.quorumWeight, uint256(circulating) * 1000 / 10_000);

        // mid's 5% of supply now clears the quorum on its own.
        _vote(id, mid, FOR);
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
    }

    // ---- state table

    function test_state_unknownIsNone() public view {
        _assertState(0, ITakeoverGovernor.State.None);
        _assertState(42, ITakeoverGovernor.State.None);
    }

    function test_state_lifecycle() public {
        uint256 id = _propose();
        _assertState(id, ITakeoverGovernor.State.Active);
        vm.warp(_end(id));
        _assertState(id, ITakeoverGovernor.State.Active);
        vm.warp(_end(id) + 1);
        _assertState(id, ITakeoverGovernor.State.Closing);
        gov.closeProposal(id);
        _assertState(id, ITakeoverGovernor.State.Closing);
        uint64[] memory counts = new uint64[](2);
        counts[FOR] = 10_000_000_000;
        scheme.submitTally(address(gov), token, id, abi.encode(counts), "");
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
        vm.warp(_deadline(id) + 1);
        _assertState(id, ITakeoverGovernor.State.Expired);
    }

    // ---- fuzz

    /// The recorded tally always equals the ballots' weights and the outcome follows the rule.
    function testFuzz_outcomeFollowsRule(uint8 picks, uint16 quorumBps) public {
        quorumBps = uint16(bound(quorumBps, 100, 5000));
        ITakeoverGovernor.Params memory q = P;
        q.quorumBps = quorumBps;
        vm.prank(owner);
        gov.setParams(q);

        uint256 id = _propose();
        address[3] memory voters = [whale, mid, proposer];
        uint64[3] memory weights = [uint64(10_000_000_000), 5_000_000_000, 2_000_000_000];
        uint64 forW;
        uint64 againstW;
        for (uint256 i; i < 3; ++i) {
            bool voteFor = (picks >> i) & 1 == 1;
            _vote(id, voters[i], voteFor ? FOR : AGAINST);
            if (voteFor) forW += weights[i];
            else againstW += weights[i];
        }
        vm.warp(_end(id) + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);

        ITakeoverGovernor.Proposal memory p = gov.getProposal(id);
        assertEq(p.forWeight, forW);
        assertEq(p.againstWeight, againstW);
        bool shouldPass = forW >= p.quorumWeight && forW > againstW;
        _assertState(
            id, shouldPass ? ITakeoverGovernor.State.Succeeded : ITakeoverGovernor.State.Defeated
        );
    }
}
