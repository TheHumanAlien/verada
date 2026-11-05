// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";

contract EpochGovernorTest is Test {
    uint256 internal constant WEEK = 7 days;
    // Token launch time (mid-week); the governor is deployed one week later so that epoch 0's
    // snapshot falls after the holders received their balances.
    uint256 internal constant T0 = 1_750_000_123;

    MockOrgFactory internal orgFactory;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    EpochGovernor internal gov;
    VeradaToken internal tokenContract;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal v1 = makeAddr("v1");
    address internal v2 = makeAddr("v2");
    address internal v3 = makeAddr("v3");
    address internal nobody = makeAddr("nobody");
    bytes32 internal causeA = keccak256("A");
    bytes32 internal causeB = keccak256("B");
    bytes32 internal causeC = keccak256("C");

    function setUp() public {
        vm.warp(T0);
        tokenContract = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        _give(v1, 100e18);
        _give(v2, 250e18);
        _give(v3, 100e18 + 0.9e18); // weight truncates to whole tokens
        vm.warp(T0 + WEEK);

        MockUSDC usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        gov = new EpochGovernor(owner, registry, scheme, ITokenProfileRegistry(address(profiles)));
        scheme.setGovernor(address(gov), true);
        profiles.register(token, creator);

        vm.startPrank(owner);
        gov.setFactory(factory);
        _addCause(causeA, "orgA");
        _addCause(causeB, "orgB");
        _addCause(causeC, "orgC");
        gov.setDefaultShortlist(_list(causeA, causeB));
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
    }

    // ---- helpers

    function _addCause(bytes32 causeId, bytes32 orgId) internal {
        registry.addCause(causeId, orgId, orgFactory.computeOrgAddress(orgId), "meta");
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        tokenContract.transfer(to, amount);
    }

    function _list(bytes32 a) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = a;
    }

    function _list(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = a;
        l[1] = b;
    }

    function _list(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](3);
        l[0] = a;
        l[1] = b;
        l[2] = c;
    }

    function _vote(address voter, uint256 epoch, uint8 choice) internal returns (bytes32) {
        vm.prank(voter);
        return scheme.castBallot(address(gov), token, epoch, abi.encode(choice));
    }

    function _ref(address voter, uint256 epoch) internal view returns (bytes32) {
        return keccak256(abi.encode(address(gov), token, epoch, voter));
    }

    function _endEpoch(uint256 epoch) internal {
        vm.warp(gov.epochStart(epoch + 1));
    }

    function _counts(uint64 a, uint64 b) internal pure returns (uint64[] memory c) {
        c = new uint64[](2);
        c[0] = a;
        c[1] = b;
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
        assertEq(gov.epochStart(0), start);
        assertEq(gov.epochStart(3), start + 3 * WEEK);
        assertEq(gov.snapshotOf(0), start - 1);
        assertEq(gov.snapshotOf(2), start + 2 * WEEK - 1);
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

    // ---- construction / registration / admin

    function test_constructor_zeroAddressReverts() public {
        ITokenProfileRegistry p = ITokenProfileRegistry(address(profiles));
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, ICauseRegistry(address(0)), scheme, p);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, IVotingScheme(address(0)), p);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, scheme, ITokenProfileRegistry(address(0)));
    }

    function test_constructor_storesConfig() public view {
        assertEq(address(gov.registry()), address(registry));
        assertEq(address(gov.profileRegistry()), address(profiles));
        assertEq(gov.scheme(), address(scheme));
        assertEq(gov.MAX_OPTIONS(), 10);
        assertEq(gov.owner(), owner);
    }

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
        vm.expectRevert(IEpochGovernor.FactoryAlreadySet.selector);
        gov.setFactory(address(1));
    }

    function test_setScheme_onlyOwner_andZeroCheck() public {
        MockVotingScheme s2 = new MockVotingScheme();
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setScheme(s2);
        vm.startPrank(owner);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        gov.setScheme(IVotingScheme(address(0)));
        vm.expectEmit(true, false, false, true);
        emit IEpochGovernor.SchemeUpdated(address(s2));
        gov.setScheme(s2);
        vm.stopPrank();
        assertEq(gov.scheme(), address(s2));
    }

    function test_setDefaultCause_guards() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
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

    // ---- shortlists

    function test_setDefaultShortlist_onlyOwner_andStored() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gov.setDefaultShortlist(_list(causeA));

        bytes32[] memory l = _list(causeC, causeA, causeB);
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IEpochGovernor.DefaultShortlistSet(l);
        gov.setDefaultShortlist(l);
        bytes32[] memory got = gov.defaultShortlist();
        assertEq(got.length, 3);
        assertEq(got[0], causeC);
        assertEq(got[1], causeA);
        assertEq(got[2], causeB);
    }

    function test_setDefaultShortlist_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setDefaultShortlist(new bytes32[](0));

        bytes32[] memory tooMany = new bytes32[](11);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setDefaultShortlist(tooMany);

        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setDefaultShortlist(_list(causeA, causeB, causeA));

        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, unknown));
        gov.setDefaultShortlist(_list(causeA, unknown));

        registry.deactivateCause(causeC);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, causeC));
        gov.setDefaultShortlist(_list(causeC));
        vm.stopPrank();
    }

    function test_setDefaultShortlist_maxOptions() public {
        vm.startPrank(owner);
        bytes32[] memory ten = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            ten[i] = keccak256(abi.encode("many", i));
            _addCause(ten[i], bytes32(abi.encode("org", i)));
        }
        gov.setDefaultShortlist(ten);
        assertEq(gov.defaultShortlist().length, 10);
        vm.stopPrank();
    }

    function test_setShortlist_onlyController() public {
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, nobody)
        );
        gov.setShortlist(token, _list(causeC));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, owner));
        gov.setShortlist(token, _list(causeC));

        vm.prank(creator);
        vm.expectEmit(true, false, false, true);
        emit IEpochGovernor.ShortlistSet(token, _list(causeC));
        gov.setShortlist(token, _list(causeC));
        bytes32[] memory got = gov.shortlistOf(token);
        assertEq(got.length, 1);
        assertEq(got[0], causeC);
    }

    function test_setShortlist_unregisteredToken() public {
        address other = makeAddr("other");
        profiles.register(other, creator);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.setShortlist(other, _list(causeC));
    }

    function test_setShortlist_validation_andClear() public {
        vm.startPrank(creator);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, _list(causeA, causeA));
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, unknown));
        gov.setShortlist(token, _list(unknown));
        bytes32[] memory tooMany = new bytes32[](11);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, tooMany);

        gov.setShortlist(token, _list(causeC));
        assertEq(gov.shortlistOf(token).length, 1);
        gov.setShortlist(token, new bytes32[](0));
        assertEq(gov.shortlistOf(token).length, 0);
        vm.stopPrank();
    }

    function test_setShortlist_followsControllerChanges() public {
        address newController = makeAddr("newController");
        profiles.setController(token, newController);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, creator)
        );
        gov.setShortlist(token, _list(causeC));
        vm.prank(newController);
        gov.setShortlist(token, _list(causeC));
    }

    // ---- open

    function test_openEpoch_freezesDefaultShortlist_andOpensPoll() public {
        bytes32[] memory expected = _list(causeA, causeB);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.PollOpened(address(gov), token, 0, 2);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochOpened(token, 0, expected);
        vm.prank(nobody);
        gov.openEpoch(token, 0);

        assertTrue(gov.isOpened(token, 0));
        assertFalse(gov.isClosed(token, 0));
        assertEq(gov.epochScheme(token, 0), address(scheme));
        bytes32[] memory opts = gov.epochOptions(token, 0);
        assertEq(opts.length, 2);
        assertEq(opts[0], causeA);
        assertEq(opts[1], causeB);
        assertTrue(scheme.isOpen(address(gov), token, 0));
        assertEq(scheme.optionCountOf(address(gov), token, 0), 2);
    }

    function test_openEpoch_prefersTokenShortlist_andIsFrozen() public {
        vm.prank(creator);
        gov.setShortlist(token, _list(causeC, causeA));
        gov.openEpoch(token, 0);
        bytes32[] memory opts = gov.epochOptions(token, 0);
        assertEq(opts.length, 2);
        assertEq(opts[0], causeC);
        assertEq(opts[1], causeA);

        // Changing shortlists afterwards does not touch the opened epoch.
        vm.prank(creator);
        gov.setShortlist(token, _list(causeB));
        vm.prank(owner);
        gov.setDefaultShortlist(_list(causeB));
        opts = gov.epochOptions(token, 0);
        assertEq(opts[0], causeC);
        assertEq(opts[1], causeA);
        // ... but the next epoch uses the new one.
        _endEpoch(0);
        gov.openEpoch(token, 1);
        opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 1);
        assertEq(opts[0], causeB);
    }

    function test_openEpoch_guards() public {
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.openEpoch(other, 0);

        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 1));
        gov.openEpoch(token, 1);

        gov.openEpoch(token, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyOpened.selector, token, 0)
        );
        gov.openEpoch(token, 0);

        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 0));
        gov.openEpoch(token, 0);
    }

    function test_openEpoch_noShortlistReverts() public {
        // A fresh governor without any default shortlist.
        EpochGovernor g =
            new EpochGovernor(owner, registry, scheme, ITokenProfileRegistry(address(profiles)));
        scheme.setGovernor(address(g), true);
        vm.prank(owner);
        g.setFactory(factory);
        vm.prank(factory);
        g.registerToken(token);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoShortlist.selector, token));
        g.openEpoch(token, 0);
        // The lazy path fails the same way.
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoShortlist.selector, token));
        scheme.castBallot(address(g), token, 0, abi.encode(uint8(0)));
    }

    // ---- ballots

    function test_weightOf_wholeTokensAtSnapshot() public {
        assertEq(gov.weightOf(token, 0, v1), 100);
        assertEq(gov.weightOf(token, 0, v2), 250);
        assertEq(gov.weightOf(token, 0, v3), 100); // 100.9 truncates
        assertEq(gov.weightOf(token, 0, nobody), 0);
        // 100_000_000_000 - 450.9, truncated to whole tokens.
        assertEq(gov.weightOf(token, 0, factory), 99_999_999_549);
        // Future epochs have no weight yet.
        assertEq(gov.weightOf(token, 1, v1), 0);
        // Tokens received after the snapshot do not count for this epoch.
        _give(nobody, 1000e18);
        vm.warp(block.timestamp + 1);
        assertEq(gov.weightOf(token, 0, nobody), 0);
        _endEpoch(0);
        assertEq(gov.weightOf(token, 1, nobody), 1000);
    }

    function test_castBallot_lazilyOpens_recordsAndEmits() public {
        assertFalse(gov.isOpened(token, 0));
        bytes32 ref = _ref(v1, 0);

        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochOpened(token, 0, _list(causeA, causeB));
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.VoteCast(token, 0, ref);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.BallotCast(address(gov), token, 0, v1, 100, ref);
        bytes32 got = _vote(v1, 0, 0);

        assertEq(got, ref);
        assertTrue(gov.isOpened(token, 0));
        assertTrue(gov.hasVoted(token, 0, v1));
        assertFalse(gov.hasVoted(token, 0, v2));
        assertEq(gov.voterCount(token, 0), 1);
        assertEq(scheme.ballotCount(address(gov), token, 0), 1);
        uint64[] memory live = scheme.liveCounts(address(gov), token, 0);
        assertEq(live[0], 100);
        assertEq(live[1], 0);
    }

    function test_castBallot_afterExplicitOpen() public {
        gov.openEpoch(token, 0);
        _vote(v2, 0, 1);
        assertEq(gov.voterCount(token, 0), 1);
        assertEq(scheme.liveCounts(address(gov), token, 0)[1], 250);
    }

    function test_authorizeBallot_onlyScheme() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotScheme.selector, nobody));
        gov.authorizeBallot(token, 0, v1, bytes32(0));
        // Still rejected once the epoch is opened.
        gov.openEpoch(token, 0);
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotScheme.selector, nobody));
        gov.authorizeBallot(token, 0, v1, bytes32(0));
        // A different scheme is not the epoch's scheme either, even once it is the current one.
        MockVotingScheme s2 = new MockVotingScheme();
        s2.setGovernor(address(gov), true);
        vm.prank(owner);
        gov.setScheme(s2);
        vm.prank(address(s2));
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotScheme.selector, address(s2)));
        gov.authorizeBallot(token, 0, v1, bytes32(0));
    }

    function test_authorizeBallot_unregisteredToken() public {
        address other = makeAddr("other");
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.authorizeBallot(other, 0, v1, bytes32(0));
    }

    function test_castBallot_wrongEpochReverts() public {
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 1));
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(0)));
        _endEpoch(0);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 0));
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(0)));
    }

    function test_castBallot_zeroWeightReverts() public {
        vm.prank(nobody);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(0)));
        // Less than one whole token is zero weight too.
        address dust = makeAddr("dust");
        _give(dust, 0.999e18);
        _endEpoch(0);
        vm.prank(dust);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(0)));
    }

    function test_castBallot_doubleVoteReverts() public {
        _vote(v1, 0, 0);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.AlreadyVoted.selector, v1));
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(1)));
        assertEq(gov.voterCount(token, 0), 1);
    }

    function test_castBallot_sameVoterAllowedNextEpoch() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        _vote(v1, 1, 1);
        assertTrue(gov.hasVoted(token, 0, v1));
        assertTrue(gov.hasVoted(token, 1, v1));
    }

    function test_castBallot_invalidChoiceRejectedByScheme() public {
        vm.prank(v1);
        vm.expectRevert(IVotingScheme.InvalidBallot.selector);
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(2)));
        // The governor's authorization is rolled back with the scheme's revert.
        assertFalse(gov.hasVoted(token, 0, v1));
        assertFalse(gov.isOpened(token, 0));
    }

    function test_voteAtLastSecondCountsForOldEpoch() public {
        vm.warp(gov.epochStart(1) - 1);
        _vote(v1, 0, 0);
        vm.warp(gov.epochStart(1));
        _vote(v2, 1, 1);
        assertEq(gov.voterCount(token, 0), 1);
        assertEq(gov.voterCount(token, 1), 1);
    }

    function test_weightImmuneToTransfersAfterSnapshot() public {
        // v2 dumps everything to v1 inside the epoch; both keep their snapshot weights.
        vm.prank(v2);
        tokenContract.transfer(v1, 250e18);
        vm.warp(block.timestamp + 1);
        _vote(v1, 0, 0);
        _vote(v2, 0, 1);
        uint64[] memory live = scheme.liveCounts(address(gov), token, 0);
        assertEq(live[0], 100);
        assertEq(live[1], 250);
    }

    // ---- close

    function test_closeEpoch_requestsTally_andEmits() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.TallyRequested(address(gov), token, 0);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochClosed(token, 0);
        vm.prank(nobody);
        gov.closeEpoch(token, 0);
        assertTrue(gov.isClosed(token, 0));
        assertTrue(scheme.isClosed(address(gov), token, 0));
        assertFalse(scheme.isOpen(address(gov), token, 0));
    }

    function test_closeEpoch_guards() public {
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.closeEpoch(other, 0);

        _vote(v1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.closeEpoch(token, 0);
        vm.warp(gov.epochStart(1) - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.closeEpoch(token, 0);

        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 1));
        gov.closeEpoch(token, 1);
        _endEpoch(1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotOpened.selector, token, 1));
        gov.closeEpoch(token, 1);

        gov.closeEpoch(token, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyClosed.selector, token, 0)
        );
        gov.closeEpoch(token, 0);
    }

    // ---- finalize

    function test_finalize_requiresFinalTally() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TallyNotFinal.selector, token, 0));
        gov.finalizeEpoch(token, 0);
        gov.closeEpoch(token, 0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TallyNotFinal.selector, token, 0));
        gov.finalizeEpoch(token, 0);
        scheme.submitTally(address(gov), token, 0, abi.encode(_counts(100, 0)), "");
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_picksHighestCount_andStoresTally() public {
        _vote(v1, 0, 0); // 100 -> A
        _vote(v2, 0, 1); // 250 -> B
        _vote(v3, 0, 0); // 100 -> A
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.finalizeFromBallots(address(gov), token, 0);

        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochFinalized(token, 0, causeB);
        vm.prank(nobody);
        gov.finalizeEpoch(token, 0);

        assertTrue(gov.isFinalized(token, 0));
        assertEq(gov.winningCause(token, 0), causeB);
        assertEq(gov.tally(token, 0, causeA), 200);
        assertEq(gov.tally(token, 0, causeB), 250);
        assertEq(gov.tally(token, 0, causeC), 0);
    }

    function test_finalize_tieGoesToLowestIndex() public {
        _vote(v1, 0, 1); // 100 -> B
        _vote(v3, 0, 0); // 100 -> A
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_submittedTallyOverridesLiveCounts() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.submitTally(address(gov), token, 0, abi.encode(_counts(7, 9)), "");
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeB);
        assertEq(gov.tally(token, 0, causeA), 7);
        assertEq(gov.tally(token, 0, causeB), 9);
    }

    function test_finalize_tallyLengthMismatchReverts() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        uint64[] memory bad = new uint64[](3);
        scheme.submitTally(address(gov), token, 0, abi.encode(bad), "");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidTally.selector, token, 0));
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_revertsBeforeEpochEnds() public {
        _vote(v1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.finalizeEpoch(token, 0);
        vm.warp(gov.epochStart(1) - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 0));
        gov.finalizeEpoch(token, 0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotEnded.selector, 5));
        gov.finalizeEpoch(token, 5);
    }

    function test_finalize_exactlyAtBoundary() public {
        _vote(v1, 0, 0);
        vm.warp(gov.epochStart(1));
        gov.closeEpoch(token, 0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_twiceReverts() public {
        _vote(v1, 0, 0);
        _endEpoch(0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyFinalized.selector, token, 0)
        );
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_unregisteredReverts() public {
        _endEpoch(0);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.finalizeEpoch(other, 0);
    }

    function test_finalize_neverOpened_noDefaultReverts() public {
        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoVotes.selector, token, 0));
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_neverOpened_usesDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _endEpoch(0);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.NoVoteFallbackApplied(token, 0, causeC);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochFinalized(token, 0, causeC);
        gov.finalizeEpoch(token, 0);
        assertTrue(gov.isFinalized(token, 0));
        assertEq(gov.winningCause(token, 0), causeC);
        assertEq(gov.tally(token, 0, causeC), 0);
    }

    function test_finalize_openedWithoutVoters_usesDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        gov.openEpoch(token, 0);
        _endEpoch(0);
        // No tally needed; the scheme is not even consulted.
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    function test_finalize_allZeroTally_usesDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v1, 0, 0);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.submitTally(address(gov), token, 0, abi.encode(_counts(0, 0)), "");
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.NoVoteFallbackApplied(token, 0, causeC);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    function test_finalize_votesBeatDefaultCause() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v1, 0, 1);
        _endEpoch(0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeB);
    }

    function test_finalize_noVotes_inactiveDefaultReverts() public {
        vm.startPrank(owner);
        gov.setDefaultCause(causeC);
        registry.deactivateCause(causeC);
        vm.stopPrank();
        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoVotes.selector, token, 0));
        gov.finalizeEpoch(token, 0);
    }

    function test_finalize_keepsWinnerAfterDeactivation() public {
        _vote(v1, 0, 0);
        vm.prank(owner);
        registry.deactivateCause(causeA);
        _endEpoch(0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    function test_finalize_laterEpochIndependent() public {
        vm.warp(gov.epochStart(3) + 5);
        _vote(v1, 3, 1);
        _endEpoch(3);
        scheme.finalizeFromBallots(address(gov), token, 3);
        gov.finalizeEpoch(token, 3);
        assertEq(gov.winningCause(token, 3), causeB);
        assertFalse(gov.isFinalized(token, 0));
        assertFalse(gov.isOpened(token, 0));
    }

    // ---- scheme swap

    function test_setScheme_onlyAffectsFutureEpochs() public {
        _vote(v1, 0, 0);
        MockVotingScheme s2 = new MockVotingScheme();
        s2.setGovernor(address(gov), true);
        vm.prank(owner);
        gov.setScheme(s2);

        // Epoch 0 keeps the old scheme: new ballots go there, s2 rejects the caller.
        assertEq(gov.epochScheme(token, 0), address(scheme));
        _vote(v2, 0, 1);
        vm.prank(v3);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotScheme.selector, address(s2)));
        s2.castBallot(address(gov), token, 0, abi.encode(uint8(0)));

        _endEpoch(0);
        gov.closeEpoch(token, 0);
        assertTrue(scheme.isClosed(address(gov), token, 0));
        assertFalse(s2.isClosed(address(gov), token, 0));
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeB);

        // Epoch 1 opens on the new scheme; the old one rejects the caller.
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotScheme.selector, address(scheme)));
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(0)));
        vm.prank(v1);
        s2.castBallot(address(gov), token, 1, abi.encode(uint8(0)));
        assertEq(gov.epochScheme(token, 1), address(s2));
        assertEq(s2.ballotCount(address(gov), token, 1), 1);
    }

    // ---- fuzz

    /// Winner always has the max count among the options; stored tallies equal the ballots.
    function testFuzz_winnerIsMaxTally(uint64[8] calldata amounts, uint8[8] calldata picks) public {
        // Fresh holders funded before the snapshot of epoch 1.
        uint256 sumA;
        uint256 sumB;
        address[8] memory voters;
        for (uint256 i; i < 8; ++i) {
            voters[i] = address(uint160(0x1000 + i));
            uint256 whole = bound(uint256(amounts[i]), 1, 1_000_000);
            _give(voters[i], whole * 1e18);
            if (picks[i] % 2 == 0) sumA += whole;
            else sumB += whole;
        }
        _endEpoch(0);
        for (uint256 i; i < 8; ++i) {
            _vote(voters[i], 1, picks[i] % 2);
        }
        _endEpoch(1);
        gov.closeEpoch(token, 1);
        scheme.finalizeFromBallots(address(gov), token, 1);
        gov.finalizeEpoch(token, 1);

        assertEq(gov.tally(token, 1, causeA), sumA);
        assertEq(gov.tally(token, 1, causeB), sumB);
        assertEq(gov.voterCount(token, 1), 8);
        bytes32 winner = gov.winningCause(token, 1);
        if (sumA >= sumB) assertEq(winner, causeA);
        else assertEq(winner, causeB);
    }

    function testFuzz_finalizeOnlyAfterBoundary(uint32 warpBy, uint8 epochSel) public {
        _vote(v1, 0, 0);
        uint256 start = gov.epochZeroStart();
        vm.warp(start + warpBy);
        uint256 cur = gov.currentEpoch();
        if (cur > 0) {
            scheme.finalizeFromBallots(address(gov), token, 0);
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
