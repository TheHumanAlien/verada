// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";
import {CatalogFixture} from "./utils/CatalogFixture.sol";

/// @dev Default setup: the token's focus is hunger x Africa, whose catalogue pool is {A, B}; the
///      controller pins A and B and the scheme caps ballots at two options, so every epoch's
///      ballot is [A, B] without rotation draws and opens with `openEpoch` (`_vote` opens it
///      first). C (hunger x Europe) and D (children x Africa) are catalogue entries outside the
///      focus; C is also an owner-added registry cause used as the fallback.
///      Rotation itself is covered by `EpochGovernorRotationTest`.
contract EpochGovernorTest is Test {
    uint256 internal constant WEEK = 7 days;
    // Token launch time (mid-week); the governor is deployed one week later so that epoch 0's
    // snapshot falls after the holders received their balances.
    uint256 internal constant T0 = 1_750_000_123;

    uint64 internal constant HUNGER = uint64(1) << 2;
    uint16 internal constant AFRICA = uint16(1) << 0;

    MockOrgFactory internal orgFactory;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    CatalogFixture internal cat;
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

    bytes32 internal orgA = bytes32("orgA");
    bytes32 internal orgB = bytes32("orgB");
    bytes32 internal orgC = bytes32("orgC");
    bytes32 internal orgD = bytes32("orgD");
    bytes32 internal causeA = keccak256(abi.encode(orgA));
    bytes32 internal causeB = keccak256(abi.encode(orgB));
    bytes32 internal causeC = keccak256(abi.encode(orgC));
    bytes32 internal causeD = keccak256(abi.encode(orgD));

    /// @dev Pins of the four entries, cached so building one makes no external call (an external
    ///      call would consume a pending `vm.prank` or `vm.expectRevert`).
    mapping(uint256 entry => IEpochGovernor.Pin) internal _pinCache;

    // Fixture entry numbers.
    uint256 internal constant E_A = 0;
    uint256 internal constant E_B = 1;
    uint256 internal constant E_C = 2;
    uint256 internal constant E_D = 3;

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
        scheme.setMaxOptions(2);
        profiles = new MockProfileRegistryLite();

        cat = new CatalogFixture();
        cat.add(cat.bucketOf(2, 0), orgA); // hunger x Africa
        cat.add(cat.bucketOf(2, 0), orgB);
        cat.add(cat.bucketOf(2, 2), orgC); // hunger x Europe
        cat.add(cat.bucketOf(3, 0), orgD); // children x Africa
        cat.publish();
        for (uint256 e; e < 4; ++e) {
            IEpochGovernor.Pin memory p = cat.pin(e);
            IEpochGovernor.Pin storage c = _pinCache[e];
            c.orgId = p.orgId;
            c.bucket = p.bucket;
            c.index = p.index;
            c.proof = p.proof;
        }

        gov = _newGov(scheme);
        profiles.register(token, creator);
        profiles.setFocus(token, HUNGER, AFRICA);

        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        _addCause(causeC, orgC);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        IEpochGovernor.Pin[] memory pins_ = _pins(E_A, E_B);
        vm.prank(creator);
        gov.setShortlist(token, pins_);
    }

    // ---- helpers

    function _newGov(IVotingScheme s) internal returns (EpochGovernor g) {
        g = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            s,
            ITokenProfileRegistry(address(profiles))
        );
        MockVotingScheme(address(s)).setGovernor(address(g), true);
    }

    function _addCause(bytes32 causeId, bytes32 orgId) internal {
        registry.addCause(causeId, orgId, orgFactory.computeOrgAddress(orgId), "meta");
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        tokenContract.transfer(to, amount);
    }

    function _pins(uint256 a) internal view returns (IEpochGovernor.Pin[] memory p) {
        p = new IEpochGovernor.Pin[](1);
        p[0] = _pinCache[a];
    }

    function _pins(uint256 a, uint256 b) internal view returns (IEpochGovernor.Pin[] memory p) {
        p = new IEpochGovernor.Pin[](2);
        p[0] = _pinCache[a];
        p[1] = _pinCache[b];
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

    /// @dev Ballots need an opened epoch; opens the current one first when nobody prepared it.
    function _open(uint256 epoch) internal {
        if (epoch == gov.currentEpoch() && !gov.isPrepared(token, epoch)) {
            gov.openEpoch(token, epoch);
        }
    }

    function _vote(address voter, uint256 epoch, uint8 choice) internal returns (bytes32) {
        _open(epoch);
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
        ICauseCatalog c = ICauseCatalog(address(cat.catalog()));
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, ICauseRegistry(address(0)), c, scheme, p);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, ICauseCatalog(address(0)), scheme, p);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, c, IVotingScheme(address(0)), p);
        vm.expectRevert(IEpochGovernor.ZeroAddress.selector);
        new EpochGovernor(owner, registry, c, scheme, ITokenProfileRegistry(address(0)));
    }

    function test_constructor_storesConfig() public view {
        assertEq(address(gov.registry()), address(registry));
        assertEq(address(gov.profileRegistry()), address(profiles));
        assertEq(gov.catalog(), address(cat.catalog()));
        assertEq(gov.scheme(), address(scheme));
        assertEq(gov.MAX_OPTIONS(), 32);
        assertEq(gov.MIN_OPTIONS(), 2);
        assertEq(gov.PINNED_MAX(), 8);
        assertEq(gov.DRAW_FACTOR(), 3);
        assertEq(gov.ballotSize(), 2); // capped by the scheme
        assertEq(gov.owner(), owner);
    }

    function test_ballotSize_followsScheme() public {
        scheme.setMaxOptions(10);
        assertEq(gov.ballotSize(), 10);
        scheme.setMaxOptions(255);
        assertEq(gov.ballotSize(), 32);
    }

    function test_registerToken_onlyFactory() public {
        vm.expectRevert(IEpochGovernor.NotFactory.selector);
        gov.registerToken(makeAddr("x"));
    }

    function test_registerToken_requiresAPoolOfTwo() public {
        address t2 = makeAddr("t2");
        // children x Africa holds only D.
        profiles.setFocus(t2, uint64(1) << 3, AFRICA);
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, t2, 1));
        gov.registerToken(t2);
        // No focus at all.
        address t3 = makeAddr("t3");
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, t3, 0));
        gov.registerToken(t3);
        // hunger x {Africa, Europe} holds A, B and C.
        profiles.setFocus(t2, HUNGER, AFRICA | (uint16(1) << 2));
        vm.prank(factory);
        gov.registerToken(t2);
        assertTrue(gov.isRegistered(t2));
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
        gov.setDefaultCause(causeC);

        vm.startPrank(owner);
        // A catalogue org that was never materialized is not a registry cause.
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, causeA));
        gov.setDefaultCause(causeA);
        gov.setDefaultCause(causeC);
        assertEq(gov.defaultCause(), causeC);
        gov.setDefaultCause(bytes32(0));
        assertEq(gov.defaultCause(), bytes32(0));
        vm.stopPrank();
    }

    // ---- pinned causes (the controller's shortlist)

    function test_setShortlist_appliedAtOnceBeforeThePrepare() public view {
        // Set in setUp before epoch 0's ballot was prepared, so it applies to epoch 0.
        bytes32[] memory got = gov.shortlistOf(token);
        assertEq(got.length, 2);
        assertEq(got[0], causeA);
        assertEq(got[1], causeB);
        bytes32[] memory orgs = gov.shortlistOrgIdsFor(token, 0);
        assertEq(orgs[0], orgA);
        assertEq(orgs[1], orgB);
        (, uint256 from) = gov.pendingShortlistOf(token);
        assertEq(from, 0);
    }

    function test_setShortlist_onlyController() public {
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, nobody)
        );
        gov.setShortlist(token, _pins(E_B, E_A));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, owner));
        gov.setShortlist(token, _pins(E_B, E_A));

        gov.openEpoch(token, 0);
        vm.prank(creator);
        vm.expectEmit(true, false, false, true);
        emit IEpochGovernor.ShortlistSet(token, _list(causeB, causeA));
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.ShortlistScheduled(token, 1, _list(causeB, causeA));
        gov.setShortlist(token, _pins(E_B, E_A));
        // Epoch 0 is prepared, so the new pins start next epoch.
        assertEq(gov.shortlistOf(token)[0], causeA);
        (bytes32[] memory pending, uint256 from) = gov.pendingShortlistOf(token);
        assertEq(from, 1);
        assertEq(pending.length, 2);
        assertEq(gov.shortlistFor(token, 0)[0], causeA);
        assertEq(gov.shortlistFor(token, 1)[0], causeB);

        _endEpoch(0);
        bytes32[] memory got = gov.shortlistOf(token);
        assertEq(got.length, 2);
        assertEq(got[0], causeB);
        assertEq(got[1], causeA);
    }

    function test_setShortlist_unregisteredToken() public {
        address other = makeAddr("other");
        profiles.register(other, creator);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        gov.setShortlist(other, _pins(E_A, E_B));
    }

    function test_setShortlist_validation() public {
        vm.startPrank(creator);
        // Duplicates.
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, _pins(E_A, E_A));
        // More than PINNED_MAX.
        IEpochGovernor.Pin[] memory tooMany = new IEpochGovernor.Pin[](9);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, tooMany);
        // Catalogue entries outside the focus.
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.OutOfFocus.selector, orgC, cat.bucketOf(2, 2))
        );
        gov.setShortlist(token, _pins(E_A, E_C));
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.OutOfFocus.selector, orgD, cat.bucketOf(3, 0))
        );
        gov.setShortlist(token, _pins(E_D));
        // Not in the catalogue: a wrong org for the entry, a bad proof, an index past the bucket.
        IEpochGovernor.Pin[] memory p = _pins(E_A);
        p[0].orgId = bytes32("forged");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotInCatalog.selector, p[0].orgId));
        gov.setShortlist(token, p);
        p = _pins(E_A);
        p[0].proof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotInCatalog.selector, orgA));
        gov.setShortlist(token, p);
        p = _pins(E_A);
        p[0].index = 2;
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotInCatalog.selector, orgA));
        gov.setShortlist(token, p);
        vm.stopPrank();

        // Blocked orgs cannot be pinned.
        vm.prank(owner);
        registry.blockOrg(orgB);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, causeB));
        gov.setShortlist(token, _pins(E_A, E_B));
    }

    function test_setShortlist_emptyClearsPins() public {
        vm.prank(creator);
        gov.setShortlist(token, new IEpochGovernor.Pin[](0));
        assertEq(gov.shortlistOf(token).length, 0);
    }

    function test_setShortlist_followsControllerChanges() public {
        address newController = makeAddr("newController");
        profiles.setController(token, newController);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, creator)
        );
        gov.setShortlist(token, _pins(E_B, E_A));
        IEpochGovernor.Pin[] memory pins_ = _pins(E_B, E_A);
        vm.prank(newController);
        gov.setShortlist(token, pins_);
    }

    /// L-1: once the epoch's ballot is prepared, a change only applies to the next epoch.
    function test_setShortlist_afterPrepareAppliesNextEpoch() public {
        vm.warp(gov.epochStart(0) + 3 days);
        _vote(v1, 0, 0); // prepares and opens epoch 0 with [A, B]
        IEpochGovernor.Pin[] memory pins_ = _pins(E_B, E_A);
        vm.prank(creator);
        gov.setShortlist(token, pins_);
        bytes32[] memory opts = gov.epochOptions(token, 0);
        assertEq(opts[0], causeA);
        assertEq(opts[1], causeB);

        _endEpoch(0);
        _vote(v1, 1, 0);
        opts = gov.epochOptions(token, 1);
        assertEq(opts[0], causeB);
        assertEq(opts[1], causeA);
    }

    function test_setShortlist_lastChangeInEpochWins_andRollsOver() public {
        gov.openEpoch(token, 0);
        vm.startPrank(creator);
        gov.setShortlist(token, _pins(E_B, E_A));
        gov.setShortlist(token, _pins(E_A));
        vm.stopPrank();
        assertEq(gov.shortlistFor(token, 1).length, 1);
        // Several epochs later the scheduled list is current, and a new change rolls it over.
        vm.warp(gov.epochStart(4));
        assertEq(gov.shortlistOf(token).length, 1);
        // One pin and a two-option ballot: the pool fills the other slot.
        gov.prepareBallot(token, 4, cat.draws(gov, registry, token, 4, HUNGER, AFRICA));
        assertEq(gov.epochOptions(token, 4).length, 2);
        IEpochGovernor.Pin[] memory pins_ = _pins(E_B, E_A);
        vm.prank(creator);
        gov.setShortlist(token, pins_);
        assertEq(gov.shortlistOf(token).length, 1);
        assertEq(gov.shortlistFor(token, 4).length, 1);
        assertEq(gov.shortlistFor(token, 5)[0], causeB);
    }

    // ---- prepare / open

    function test_openEpoch_pinsFillTheBallot_andOpensPoll() public {
        // The catalogue was published after epoch 0 began, so it first applies to epoch 1.
        (uint32 version, uint256 pool) = gov.poolOf(token, 0);
        assertEq(version, 0);
        assertEq(pool, 0);
        _endEpoch(0);
        bytes32[] memory expected = _list(causeA, causeB);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.BallotPrepared(token, 1, 1, 2, 2, expected);
        vm.expectEmit(true, true, true, true);
        emit IVotingScheme.PollOpened(address(gov), token, 1, 2);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochOpened(token, 1, expected);
        vm.prank(nobody);
        gov.openEpoch(token, 1);

        assertTrue(gov.isPrepared(token, 1));
        assertTrue(gov.isOpened(token, 1));
        assertFalse(gov.isClosed(token, 1));
        assertEq(gov.epochScheme(token, 1), address(scheme));
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 2);
        assertEq(opts[0], causeA);
        assertEq(opts[1], causeB);
        bytes32[] memory orgs = gov.epochOptionOrgIds(token, 1);
        assertEq(orgs[0], orgA);
        assertEq(orgs[1], orgB);
        assertTrue(scheme.isOpen(address(gov), token, 1));
        assertEq(scheme.optionCountOf(address(gov), token, 1), 2);
        (version, pool) = gov.poolOf(token, 1);
        assertEq(version, 1);
        assertEq(pool, 2);
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
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyOpened.selector, token, 0)
        );
        gov.prepareBallot(token, 0, new IEpochGovernor.Draw[](0));

        _endEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 0));
        gov.openEpoch(token, 0);
    }

    function test_openEpoch_needsDrawsWhenPinsDoNotFillTheBallot() public {
        scheme.setMaxOptions(10);
        _endEpoch(0);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteBallot.selector, token, 1, 0)
        );
        gov.openEpoch(token, 1);
        // A ballot does not prepare the epoch either.
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotOpened.selector, token, 1));
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(0)));

        // The pool {A, B} fits the free slots, so it is walked in order; both repeat the pins.
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, HUNGER, AFRICA);
        assertEq(d.length, 2);
        gov.prepareBallot(token, 1, d);
        assertEq(gov.epochOptions(token, 1).length, 2);
    }

    function test_prepare_tooFewOptionsDoesNotOpen() public {
        // No pins, and one of the two pool entries blocked: a single option is no poll.
        vm.prank(creator);
        gov.setShortlist(token, new IEpochGovernor.Pin[](0));
        vm.prank(owner);
        registry.blockOrg(orgB);
        _endEpoch(0);
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, HUNGER, AFRICA);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.BallotPrepared(token, 1, 1, 2, 0, _list(causeA));
        gov.prepareBallot(token, 1, d);
        assertTrue(gov.isPrepared(token, 1));
        assertFalse(gov.isOpened(token, 1));
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoShortlist.selector, token));
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(0)));

        // The epoch finalizes to the default cause.
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _endEpoch(1);
        gov.finalizeEpoch(token, 1);
        assertEq(gov.winningCause(token, 1), causeC);
    }

    function test_prepare_skipsBlockedPins() public {
        scheme.setMaxOptions(10);
        vm.prank(owner);
        registry.blockOrg(orgA);
        _endEpoch(0);
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, HUNGER, AFRICA);
        assertEq(d.length, 2);
        gov.prepareBallot(token, 1, d);
        // A is blocked (pinned and drawn), B is pinned; one option.
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 1);
        assertEq(opts[0], causeB);
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

    function test_castBallot_recordsAndEmits() public {
        assertFalse(gov.isOpened(token, 0));
        bytes32 ref = _ref(v1, 0);

        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochOpened(token, 0, _list(causeA, causeB));
        gov.openEpoch(token, 0);
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
        s2.setMaxOptions(2);
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
        _open(0);
        vm.prank(nobody);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(0)));
        // Less than one whole token is zero weight too.
        address dust = makeAddr("dust");
        _give(dust, 0.999e18);
        _endEpoch(0);
        _open(1);
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
        _open(0);
        vm.prank(v1);
        vm.expectRevert(IVotingScheme.InvalidBallot.selector);
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(2)));
        // The governor's authorization is rolled back with the scheme's revert.
        assertFalse(gov.hasVoted(token, 0, v1));
        assertEq(gov.voterCount(token, 0), 0);
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
        registry.blockOrg(orgA);
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

    // ---- tally timeout (M-3)

    /// Ported PoC: delisting the governor on the scheme used to make `closeEpoch` revert and
    /// `finalizeEpoch` revert forever, stranding the cause pool. Now the close is recorded as
    /// failed and the epoch falls back to the default cause once the grace period has passed.
    function test_delistedScheme_closeRecordsFailure_andFinalizeFallsBackAfterGrace() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v1, 0, 0);
        scheme.setGovernor(address(gov), false); // the scheme owner delists the governor
        _endEpoch(0);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochCloseFailed(token, 0);
        gov.closeEpoch(token, 0);
        assertTrue(gov.isClosed(token, 0));
        assertTrue(gov.closeFailed(token, 0));

        assertEq(gov.TALLY_GRACE(), 14 days);
        uint256 graceEnd = gov.epochStart(1) + gov.TALLY_GRACE();
        vm.warp(graceEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TallyNotFinal.selector, token, 0));
        gov.finalizeEpoch(token, 0);

        vm.warp(graceEnd);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.TallyTimeoutFallbackApplied(token, 0, causeC);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochFinalized(token, 0, causeC);
        gov.finalizeEpoch(token, 0);
        assertTrue(gov.isFinalized(token, 0));
        assertEq(gov.winningCause(token, 0), causeC);
        assertEq(gov.tally(token, 0, causeA), 0);
    }

    function test_closeEpoch_retryAfterFailure() public {
        _vote(v1, 0, 0);
        scheme.setFailures(true, false, false);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        assertTrue(gov.closeFailed(token, 0));
        assertFalse(scheme.isClosed(address(gov), token, 0));

        scheme.setFailures(false, false, false);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.EpochClosed(token, 0);
        gov.closeEpoch(token, 0);
        assertFalse(gov.closeFailed(token, 0));
        assertTrue(scheme.isClosed(address(gov), token, 0));
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyClosed.selector, token, 0)
        );
        gov.closeEpoch(token, 0);

        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeA);
    }

    /// A caller cannot mark the close as failed by starving the scheme call of gas.
    function test_closeEpoch_gasStarvedSchemeCallReverts() public {
        _vote(v1, 0, 0);
        scheme.setFailures(false, true, false);
        _endEpoch(0);
        vm.expectRevert(IEpochGovernor.InsufficientGas.selector);
        gov.closeEpoch{gas: 1_000_000}(token, 0);
        assertFalse(gov.isClosed(token, 0));
        assertFalse(gov.closeFailed(token, 0));
    }

    function test_finalize_validTallyWithinGraceCounts() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v2, 0, 1);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        vm.warp(gov.epochStart(1) + gov.TALLY_GRACE() - 1);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeB);
        assertEq(gov.tally(token, 0, causeB), 250);
    }

    function test_finalize_invalidTally_fallsBackAfterGrace() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v1, 0, 0);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.submitTally(address(gov), token, 0, abi.encode(new uint64[](3)), "");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidTally.selector, token, 0));
        gov.finalizeEpoch(token, 0);
        vm.warp(gov.epochStart(1) + gov.TALLY_GRACE());
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.TallyTimeoutFallbackApplied(token, 0, causeC);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    function test_finalize_revertingTallyOf_treatedAsNotFinal() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        _vote(v1, 0, 0);
        _endEpoch(0);
        gov.closeEpoch(token, 0);
        scheme.setFailures(false, false, true);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TallyNotFinal.selector, token, 0));
        gov.finalizeEpoch(token, 0);
        vm.warp(gov.epochStart(1) + gov.TALLY_GRACE());
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    function test_finalize_afterGrace_needsDefaultCause() public {
        _vote(v1, 0, 0);
        vm.warp(gov.epochStart(1) + gov.TALLY_GRACE());
        // Never closed and no tally: the fallback still needs a default cause.
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NoVotes.selector, token, 0));
        gov.finalizeEpoch(token, 0);
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        gov.finalizeEpoch(token, 0);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    // ---- scheme swap

    function test_setScheme_onlyAffectsFutureEpochs() public {
        _vote(v1, 0, 0);
        MockVotingScheme s2 = new MockVotingScheme();
        s2.setMaxOptions(2);
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
        gov.openEpoch(token, 1);
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
