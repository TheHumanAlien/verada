// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "../utils/BallotLog.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @dev Regression tests for the launch epoch snapshot and for binding ballot indices to the
///      frozen option list. Focus hunger x Africa, pool {A, B}; the scheme caps ballots at two
///      options. The catalogue is published during epoch 0, so it applies from epoch 1.
contract EpochGovernorLaunchAndBindingTest is BallotLog {
    uint256 internal constant WEEK = 7 days;
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
    address internal late = makeAddr("late");

    bytes32 internal orgA = bytes32("orgA");
    bytes32 internal orgB = bytes32("orgB");
    bytes32 internal orgC = bytes32("orgC");
    bytes32 internal causeA = keccak256(abi.encode(orgA));
    bytes32 internal causeB = keccak256(abi.encode(orgB));
    bytes32 internal causeC = keccak256(abi.encode(orgC));

    IEpochGovernor.Pin internal pinA;
    IEpochGovernor.Pin internal pinB;

    function setUp() public {
        _recordBallots();
        // The token predates the governor by a week, so epoch 0 has a regular snapshot.
        vm.warp(T0);
        tokenContract = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        _give(tokenContract, v1, 100e18);
        _give(tokenContract, v2, 250e18);
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
        cat.add(cat.bucketOf(2, 2), orgC); // hunger x Europe (fallback cause)
        cat.publish();
        _cachePin(pinA, 0);
        _cachePin(pinB, 1);

        gov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            scheme,
            ITokenProfileRegistry(address(profiles))
        );
        scheme.setGovernor(address(gov), true);
        profiles.register(token, creator);
        profiles.setFocus(token, HUNGER, AFRICA);

        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        registry.addCause(causeC, orgC, orgFactory.computeOrgAddress(orgC), "meta");
        gov.setDefaultCause(causeC);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
    }

    // ---- helpers

    function _cachePin(IEpochGovernor.Pin storage c, uint256 entry) internal {
        IEpochGovernor.Pin memory p = cat.pin(entry);
        c.orgId = p.orgId;
        c.bucket = p.bucket;
        c.index = p.index;
        c.proof = p.proof;
    }

    function _pins(IEpochGovernor.Pin storage a, IEpochGovernor.Pin storage b)
        internal
        view
        returns (IEpochGovernor.Pin[] memory p)
    {
        p = new IEpochGovernor.Pin[](2);
        p[0] = a;
        p[1] = b;
    }

    function _give(VeradaToken t, address to, uint256 amount) internal {
        vm.prank(factory);
        assertTrue(t.transfer(to, amount));
    }

    function _vote(address t, address voter, uint256 epoch, uint8 choice) internal {
        vm.prank(voter);
        scheme.castBallot(address(gov), t, epoch, abi.encode(choice));
    }

    function _settle(address t, uint256 epoch) internal {
        vm.warp(gov.epochStart(epoch + 1));
        gov.closeEpoch(t, epoch);
        scheme.finalizeFromBallots(address(gov), t, epoch);
        gov.finalizeEpoch(t, epoch, _orgIds(address(gov), t, epoch));
    }

    /// @dev Launches a fresh token now: created, given its focus and registered in the same
    ///      block, like the factory does.
    function _launch() internal returns (VeradaToken t) {
        t = new VeradaToken("Launch", "LNCH", "ipfs://l", creator, factory);
        profiles.register(address(t), creator);
        profiles.setFocus(address(t), HUNGER, AFRICA);
        vm.prank(factory);
        gov.registerToken(address(t));
    }

    function _prepare(address t, uint256 epoch) internal {
        gov.prepareBallot(t, epoch, cat.draws(gov, registry, t, epoch, HUNGER, AFRICA));
    }

    // ---- launch epoch

    /// Holders who bought in the launch epoch vote on its fees. Before the fix the weight was
    /// read at the second before the epoch, when the token did not exist, so every weight was
    /// zero, every ballot reverted and the launch epoch always paid the default cause.
    function test_launchEpoch_holdersCanVote() public {
        vm.warp(gov.epochStart(1) + 2 days);
        uint256 launchedAt = block.timestamp;
        VeradaToken t = _launch();
        address ta = address(t);
        _prepare(ta, 1);
        bytes32[] memory opts = _options(address(gov), ta, 1);
        assertEq(opts[0], causeA);
        assertEq(opts[1], causeB);

        vm.warp(launchedAt + 1 hours);
        _give(t, v1, 300e18);
        _give(t, v2, 200e18);

        // Not before the launch snapshot.
        assertEq(gov.weightOf(ta, 1, v1), 0);
        vm.prank(v1);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), ta, 1, abi.encode(uint8(1)));

        vm.warp(launchedAt + 1 days + 1);
        _give(t, late, 1000e18); // after the launch snapshot: no weight in the launch epoch
        assertEq(gov.weightOf(ta, 1, v1), 300);
        assertEq(gov.weightOf(ta, 1, v2), 200);
        assertEq(gov.weightOf(ta, 1, late), 0);
        vm.prank(late);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), ta, 1, abi.encode(uint8(0)));

        _vote(ta, v1, 1, 1); // B
        _vote(ta, v2, 1, 0); // A
        _settle(ta, 1);
        assertEq(gov.winningCause(ta, 1), causeB, "not the default cause");
        assertEq(gov.tally(ta, 1, causeB), 300);
        assertEq(gov.tally(ta, 1, causeA), 200);

        // The next epoch reads the regular snapshot again.
        assertEq(gov.weightOf(ta, 2, late), 1000);
    }

    function test_launchSnapshot_dayAfterRegistration_emitted() public {
        vm.warp(gov.epochStart(1) + 1 days);
        VeradaToken t = new VeradaToken("Launch", "LNCH", "ipfs://l", creator, factory);
        profiles.register(address(t), creator);
        profiles.setFocus(address(t), HUNGER, AFRICA);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.LaunchSnapshotSet(address(t), 1, block.timestamp + 1 days);
        vm.prank(factory);
        gov.registerToken(address(t));

        assertEq(gov.LAUNCH_SNAPSHOT_DELAY(), 1 days);
        assertLt(gov.snapshotOf(1), block.timestamp, "regular snapshot predates the token");
        assertEq(gov.launchSnapshotOf(address(t)), block.timestamp + 1 days);
        assertEq(gov.snapshotFor(address(t), 1), block.timestamp + 1 days);
        assertEq(gov.snapshotFor(address(t), 2), gov.snapshotOf(2));
        assertEq(gov.snapshotFor(address(t), 0), gov.snapshotOf(0));
    }

    /// With less than two days left the launch snapshot sits halfway to the epoch's end, so it
    /// stays inside the launch epoch.
    function test_launchSnapshot_halfwayWhenEpochEndsSoon() public {
        vm.warp(gov.epochStart(2) - 10 hours);
        VeradaToken t = _launch();
        assertEq(gov.launchSnapshotOf(address(t)), block.timestamp + 5 hours);
        assertEq(gov.snapshotFor(address(t), 1), block.timestamp + 5 hours);
        assertEq(gov.snapshotFor(address(t), 2), gov.snapshotOf(2));
    }

    /// A token that already had supply at the epoch's snapshot keeps the regular snapshot.
    function test_launchSnapshot_notSetWhenSupplyPredatesEpoch() public view {
        assertEq(gov.launchSnapshotOf(token), 0);
        assertEq(gov.snapshotFor(token, 0), gov.snapshotOf(0));
        assertEq(gov.weightOf(token, 0, v2), 250);
    }

    // ---- ballot indices bound to the frozen option list

    /// The controller can change the pins of an epoch whose ballot is not prepared. Before the
    /// fix the first ballot prepared the epoch itself, so a voter who encrypted index 1 for B
    /// (read from `shortlistFor`) was counted for A after the controller reordered the pins in
    /// front of the ballot. Ballots now need an opened epoch, whose list is frozen.
    function test_ballotBeforeOpen_rejected_controllerCannotRedirectIt() public {
        vm.prank(creator);
        gov.setShortlist(token, _pins(pinA, pinB));
        vm.warp(gov.epochStart(1) + 1 hours);
        assertEq(gov.shortlistFor(token, 1)[1], causeB);
        uint8 choice = 1; // B, as the voter's client encrypts it

        // The controller reorders the pins in front of the ballot.
        vm.prank(creator);
        gov.setShortlist(token, _pins(pinB, pinA));
        assertFalse(gov.isPrepared(token, 1));

        vm.prank(v2);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotOpened.selector, token, 1));
        scheme.castBallot(address(gov), token, 1, abi.encode(choice));
        assertFalse(gov.isOpened(token, 1));

        // Once opened, the list is frozen: the voter reads it, and later pin changes only apply
        // from the next epoch.
        gov.openEpoch(token, 1);
        bytes32[] memory opts = _options(address(gov), token, 1);
        assertEq(opts[0], causeB);
        assertEq(opts[1], causeA);
        vm.prank(creator);
        gov.setShortlist(token, _pins(pinA, pinB));
        assertEq(_options(address(gov), token, 1)[0], causeB);

        _vote(token, v2, 1, 0); // B, read from BallotPrepared
        _vote(token, v1, 1, 1); // A
        _settle(token, 1);
        assertEq(gov.winningCause(token, 1), causeB);
        assertEq(gov.tally(token, 1, causeB), 250);
        assertEq(gov.shortlistFor(token, 2)[0], causeA);
    }

    /// The lazy path is gone for epochs that need no draws as well: a ballot on an unprepared
    /// epoch reverts and opens nothing.
    function test_ballotBeforeOpen_doesNotPrepare() public {
        vm.prank(creator);
        gov.setShortlist(token, _pins(pinA, pinB));
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotOpened.selector, token, 0));
        scheme.castBallot(address(gov), token, 0, abi.encode(uint8(0)));
        assertFalse(gov.isPrepared(token, 0));
        assertFalse(scheme.isOpen(address(gov), token, 0));
    }
}
