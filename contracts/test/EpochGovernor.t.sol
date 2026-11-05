// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {PublicSnapshotVerifier} from "../src/governance/PublicSnapshotVerifier.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";

contract EpochGovernorTest is Test {
    uint256 internal constant WEEK = 7 days;

    MockOrgFactory internal orgFactory;
    CauseRegistry internal registry;
    EpochGovernor internal gov;
    PublicSnapshotVerifier internal verifier;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal token = makeAddr("token");
    bytes32 internal causeA = keccak256("A");
    bytes32 internal causeB = keccak256("B");

    function setUp() public {
        // An arbitrary mid-week timestamp, to exercise Thursday alignment.
        vm.warp(1_750_000_123);
        MockUSDC usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        verifier = new PublicSnapshotVerifier();
        gov = new EpochGovernor(owner, registry, verifier);
        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.addCause(
            causeA, bytes32("orgA"), orgFactory.computeOrgAddress(bytes32("orgA")), "a"
        );
        registry.addCause(
            causeB, bytes32("orgB"), orgFactory.computeOrgAddress(bytes32("orgB")), "b"
        );
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
    }

    function _proof(address voter, uint256 weight) internal pure returns (bytes memory) {
        return abi.encode(voter, weight);
    }

    function _vote(address voter, bytes32 cause, uint256 weight) internal {
        gov.castVote(token, cause, _proof(voter, weight));
    }

    // ---- epoch maths

    function test_epochZeroAlignedToThursday() public view {
        uint256 start = gov.epochZeroStart();
        assertEq(start % WEEK, 0);
        assertLe(start, block.timestamp);
        assertGt(start + WEEK, block.timestamp);
        // 1970-01-01 was a Thursday, so multiples of a week are Thursday 00:00 UTC.
        assertEq((start / 1 days + 4) % 7, 4);
        assertEq(gov.EPOCH_LENGTH(), 7 days);
        assertEq(gov.currentEpoch(), 0);
    }

    function test_epochBoundaries() public {
        uint256 start = gov.epochZeroStart();
        vm.warp(start + WEEK - 1);
        assertEq(gov.currentEpoch(), 0);
        vm.warp(start + WEEK);
        assertEq(gov.currentEpoch(), 1);
        vm.warp(start + 2 * WEEK - 1);
        assertEq(gov.currentEpoch(), 1);
        vm.warp(start + 2 * WEEK);
        assertEq(gov.currentEpoch(), 2);
    }

    function testFuzz_currentEpoch(uint32 elapsed) public {
        uint256 start = gov.epochZeroStart();
        vm.warp(start + elapsed);
        assertEq(gov.currentEpoch(), uint256(elapsed) / WEEK);
    }

    // ---- registration / admin

    function test_registerToken_onlyFactory() public {
        vm.expectRevert(IEpochGovernor.NotFactory.selector);
        gov.registerToken(makeAddr("x"));
    }

    function test_setFactory_once_andOnlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setFactory(address(1));
        vm.prank(owner);
        vm.expectRevert(EpochGovernor.FactoryAlreadySet.selector);
        gov.setFactory(address(1));
    }

    function test_constructor_zeroAddressReverts() public {
        vm.expectRevert(EpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, PublicSnapshotVerifier(address(0)));
    }

    // ---- voting

    function test_castVote_tallies_andEmits() public {
        address voter = makeAddr("v1");
        bytes32 ref = keccak256(abi.encode(token, uint256(0), voter));
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.VoteCast(token, 0, ref);
        _vote(voter, causeA, 100);
        assertEq(gov.tally(token, 0, causeA), 100);
        assertEq(gov.tally(token, 0, causeB), 0);
    }

    function test_castVote_unregisteredToken() public {
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.castVote(other, causeA, _proof(address(1), 1));
    }

    function test_castVote_inactiveOrUnknownCause() public {
        vm.prank(owner);
        registry.deactivateCause(causeB);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, causeB));
        gov.castVote(token, causeB, _proof(address(1), 1));
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, unknown));
        gov.castVote(token, unknown, _proof(address(1), 1));
    }

    function test_castVote_invalidProof() public {
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        gov.castVote(token, causeA, _proof(address(1), 0));
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        gov.castVote(token, causeA, _proof(address(0), 5));
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        gov.castVote(token, causeA, hex"01");
    }

    function test_castVote_doubleVoteSameEpoch() public {
        address voter = makeAddr("v1");
        _vote(voter, causeA, 10);
        bytes32 ref = keccak256(abi.encode(token, uint256(0), voter));
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.VoteAlreadyUsed.selector, ref));
        _vote(voter, causeB, 10);
    }

    function test_castVote_sameVoterAllowedNextEpoch() public {
        address voter = makeAddr("v1");
        _vote(voter, causeA, 10);
        vm.warp(gov.epochZeroStart() + WEEK);
        _vote(voter, causeB, 10);
        assertEq(gov.tally(token, 0, causeA), 10);
        assertEq(gov.tally(token, 1, causeB), 10);
    }

    function test_voteAtLastSecondCountsForOldEpoch() public {
        vm.warp(gov.epochZeroStart() + WEEK - 1);
        _vote(makeAddr("v1"), causeA, 7);
        assertEq(gov.tally(token, 0, causeA), 7);
        vm.warp(gov.epochZeroStart() + WEEK);
        _vote(makeAddr("v2"), causeB, 9);
        assertEq(gov.tally(token, 1, causeB), 9);
        assertEq(gov.tally(token, 0, causeB), 0);
    }

    // ---- finalize

    function test_finalize_picksHighestTally() public {
        _vote(makeAddr("v1"), causeA, 10);
        _vote(makeAddr("v2"), causeB, 25);
        _vote(makeAddr("v3"), causeA, 10);
        _vote(makeAddr("v4"), causeA, 6);
        // A = 26 > B = 25
        vm.warp(gov.epochZeroStart() + WEEK);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochFinalized(token, 0, causeA);
        gov.finalizeEpoch(token, 0);
        assertTrue(gov.isFinalized(token, 0));
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_tieGoesToFirstToReachWeight() public {
        _vote(makeAddr("v1"), causeA, 10);
        _vote(makeAddr("v2"), causeB, 10);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_revertsBeforeEpochEnds() public {
        _vote(makeAddr("v1"), causeA, 10);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.finalizeEpoch(token, 0);
        vm.warp(gov.epochZeroStart() + WEEK - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.finalizeEpoch(token, 0);
        // Future epochs too.
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 5));
        gov.finalizeEpoch(token, 5);
    }

    function test_finalize_exactlyAtBoundary() public {
        _vote(makeAddr("v1"), causeA, 10);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_twiceReverts() public {
        _vote(makeAddr("v1"), causeA, 10);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyFinalized.selector, token, 0)
        );
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_noVotesReverts() public {
        vm.warp(gov.epochZeroStart() + WEEK);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoVotes.selector, token, 0));
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_noVotes_usesDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeB);
        vm.warp(gov.epochZeroStart() + WEEK);

        vm.expectEmit(true, true, false, true);
        emit EpochGovernor.NoVoteFallbackApplied(token, 0, causeB);
        gov.finalizeEpoch(token, 0);

        assertTrue(gov.isFinalized(token, 0));
        assertEq(gov.winningCause(token, 0), causeB);
    }

    function test_finalize_votesBeatDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeB);
        _vote(makeAddr("v1"), causeA, 10);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_noVotes_inactiveDefaultReverts() public {
        vm.startPrank(owner);
        gov.setDefaultCause(causeB);
        registry.deactivateCause(causeB);
        vm.stopPrank();
        vm.warp(gov.epochZeroStart() + WEEK);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoVotes.selector, token, 0));
        gov.finalizeEpoch(token, 0);
    }

    function test_setDefaultCause_guards() public {
        vm.expectRevert();
        gov.setDefaultCause(causeA);

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, bytes32(uint256(1)))
        );
        gov.setDefaultCause(bytes32(uint256(1)));
        gov.setDefaultCause(causeA);
        assertEq(gov.defaultCause(), causeA);
        gov.setDefaultCause(bytes32(0));
        assertEq(gov.defaultCause(), bytes32(0));
        vm.stopPrank();
    }

    function test_finalize_unregisteredReverts() public {
        vm.warp(gov.epochZeroStart() + WEEK);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.finalizeEpoch(other, 0);
    }

    function test_finalize_keepsWinnerAfterDeactivation() public {
        _vote(makeAddr("v1"), causeA, 10);
        vm.prank(owner);
        registry.deactivateCause(causeA);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_laterEpochIndependent() public {
        vm.warp(gov.epochZeroStart() + 3 * WEEK + 5);
        _vote(makeAddr("v1"), causeB, 4);
        vm.warp(gov.epochZeroStart() + 4 * WEEK);
        gov.finalizeEpoch(token, 3);
        assertEq(gov.winningCause(token, 3), causeB);
        assertFalse(gov.isFinalized(token, 0));
    }

    function test_setVerifier_onlyOwner() public {
        PublicSnapshotVerifier v2 = new PublicSnapshotVerifier();
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setVerifier(v2);
        vm.prank(owner);
        gov.setVerifier(v2);
        assertEq(address(gov.verifier()), address(v2));
        vm.prank(owner);
        vm.expectRevert(EpochGovernor.ZeroAddress.selector);
        gov.setVerifier(PublicSnapshotVerifier(address(0)));
    }

    // ---- fuzz

    /// Winner always has the max tally among voted causes; sums match.
    function testFuzz_winnerIsMaxTally(uint96[8] calldata weights, uint8[8] calldata picks) public {
        bytes32[2] memory causes = [causeA, causeB];
        uint256 sumA;
        uint256 sumB;
        for (uint256 i; i < 8; ++i) {
            uint256 w = uint256(weights[i]) + 1;
            bytes32 c = causes[picks[i] % 2];
            if (picks[i] % 2 == 0) sumA += w;
            else sumB += w;
            _vote(address(uint160(i + 1)), c, w);
        }
        assertEq(gov.tally(token, 0, causeA), sumA);
        assertEq(gov.tally(token, 0, causeB), sumB);
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        bytes32 winner = gov.winningCause(token, 0);
        if (sumA > sumB) assertEq(winner, causeA);
        else if (sumB > sumA) assertEq(winner, causeB);
        else assertTrue(winner == causeA || winner == causeB);
    }

    function testFuzz_finalizeOnlyAfterBoundary(uint32 warpBy, uint8 epochSel) public {
        _vote(makeAddr("v1"), causeA, 1);
        uint256 start = gov.epochZeroStart();
        vm.warp(start + warpBy);
        uint256 cur = gov.currentEpoch();
        if (cur > 0) {
            gov.finalizeEpoch(token, 0);
            assertTrue(gov.isFinalized(token, 0));
        } else {
            vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
            gov.finalizeEpoch(token, 0);
        }
        uint256 future = cur + uint256(epochSel);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, future));
        gov.finalizeEpoch(token, future);
    }
}
