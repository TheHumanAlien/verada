// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "./utils/BallotLog.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";
import {CatalogFixture} from "./utils/CatalogFixture.sol";

/// @notice Ballot composition from a large focus pool: pins first, then deterministic rotation
///         draws verified against the catalogue.
/// @dev Catalogue: 30 orgs in hunger x Africa, 20 in children x Africa (the first 5 of which are
///      also in hunger x Africa, so they appear twice in a hunger+children focus), and 10 in
///      hunger x Europe outside the focus. The token's focus is {hunger, children} x Africa, a
///      pool of 50 entries. The scheme allows 10 options.
contract EpochGovernorRotationTest is BallotLog {
    uint256 internal constant WEEK = 7 days;
    uint64 internal constant FOCUS_C = (uint64(1) << 2) | (uint64(1) << 3);
    uint16 internal constant FOCUS_R = uint16(1);

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
    address internal voter = makeAddr("voter");

    function _org(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("org", i));
    }

    function setUp() public {
        _recordBallots();
        vm.warp(1_750_000_123);
        tokenContract = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        vm.prank(factory);
        tokenContract.transfer(voter, 1000e18);
        vm.warp(block.timestamp + WEEK);

        MockUSDC usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(10);
        profiles = new MockProfileRegistryLite();

        cat = new CatalogFixture();
        for (uint256 i; i < 30; ++i) {
            cat.add(cat.bucketOf(2, 0), _org(i)); // entries 0..29
        }
        for (uint256 i; i < 20; ++i) {
            cat.add(cat.bucketOf(3, 0), _org(i < 5 ? i : 100 + i)); // entries 30..49
        }
        for (uint256 i; i < 10; ++i) {
            cat.add(cat.bucketOf(2, 2), _org(200 + i)); // entries 50..59, outside the focus
        }
        cat.publish();

        gov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            scheme,
            ITokenProfileRegistry(address(profiles))
        );
        scheme.setGovernor(address(gov), true);
        profiles.register(token, creator);
        profiles.setFocus(token, FOCUS_C, FOCUS_R);
        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        // Version 1 applies from the next epoch (it was set after epoch 0 began).
        vm.warp(gov.epochStart(1));
    }

    function _draws(uint256 epoch) internal view returns (IEpochGovernor.Draw[] memory) {
        return cat.draws(gov, registry, token, epoch, FOCUS_C, FOCUS_R);
    }

    function _causeOf(uint256 entry) internal view returns (bytes32) {
        return keccak256(abi.encode(cat.entryAt(entry).orgId));
    }

    function _contains(bytes32[] memory list, bytes32 x) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == x) return true;
        }
        return false;
    }

    function test_poolOf_usesTheVersionInEffectAtTheEpochStart() public {
        (uint32 v0, uint256 p0) = gov.poolOf(token, 0);
        assertEq(v0, 0, "set after epoch 0 began");
        assertEq(p0, 0);
        (uint32 v1, uint256 p1) = gov.poolOf(token, 1);
        assertEq(v1, 1);
        assertEq(p1, 50);
    }

    function test_rotationFillsTheBallotWithDistinctInFocusCauses() public {
        IEpochGovernor.Draw[] memory d = _draws(1);
        assertGe(d.length, 10);
        gov.prepareBallot(token, 1, d);
        bytes32[] memory opts = _options(address(gov), token, 1);
        bytes32[] memory orgs = _orgIds(address(gov), token, 1);
        assertEq(opts.length, 10);
        assertTrue(gov.isOpened(token, 1));
        for (uint256 i; i < opts.length; ++i) {
            for (uint256 j; j < i; ++j) {
                assertTrue(opts[i] != opts[j], "repeat");
            }
            bytes32 orgId = orgs[i];
            assertEq(opts[i], keccak256(abi.encode(orgId)), "cause id of the stored org");
            for (uint256 e = 50; e < 60; ++e) {
                assertTrue(orgId != cat.entryAt(e).orgId, "outside the focus");
            }
        }
        // The k-th draw is pool entry drawIndex(k).
        uint256 first = gov.drawIndex(token, 1, 1, 0, 50);
        assertEq(
            first, uint256(keccak256(abi.encode(token, uint256(1), uint32(1), uint256(0)))) % 50
        );
        (uint16 b, uint32 idx) = cat.catalog().locate(1, FOCUS_C, FOCUS_R, first);
        assertEq(opts[0], keccak256(abi.encode(cat.entryAt(cat.find(b, idx)).orgId)));
    }

    function test_rotationIsDeterministicPerEpoch_andDiffersAcrossEpochs() public {
        gov.prepareBallot(token, 1, _draws(1));
        bytes32[] memory e1 = _options(address(gov), token, 1);
        vm.warp(gov.epochStart(2));
        gov.prepareBallot(token, 2, _draws(2));
        bytes32[] memory e2 = _options(address(gov), token, 2);
        bool differs;
        for (uint256 i; i < e1.length; ++i) {
            if (e1[i] != e2[i]) differs = true;
        }
        assertTrue(differs);
    }

    function test_pinsComeFirst_andAreNotRepeatedByRotation() public {
        IEpochGovernor.Pin[] memory pins = new IEpochGovernor.Pin[](3);
        pins[0] = cat.pin(7);
        pins[1] = cat.pin(31); // children x Africa
        pins[2] = cat.pin(2);
        vm.prank(creator);
        gov.setShortlist(token, pins);
        IEpochGovernor.Draw[] memory d = _draws(1);
        vm.expectEmit(true, true, false, false);
        emit IEpochGovernor.BallotPrepared(token, 1, 1, 50, 3, new bytes32[](0));
        gov.prepareBallot(token, 1, d);
        bytes32[] memory opts = _options(address(gov), token, 1);
        assertEq(opts.length, 10);
        assertEq(opts[0], _causeOf(7));
        assertEq(opts[1], _causeOf(31));
        assertEq(opts[2], _causeOf(2));
        for (uint256 i = 3; i < opts.length; ++i) {
            assertTrue(opts[i] != opts[0] && opts[i] != opts[1] && opts[i] != opts[2]);
        }
    }

    function test_anOrgInTwoBucketsAppearsOnce() public {
        // Entries 0..4 of hunger and 30..34 of children are the same five orgs; a 32-option
        // ballot drawn from the 50-entry pool never holds one twice.
        scheme.setMaxOptions(32);
        IEpochGovernor.Draw[] memory d = _draws(1);
        gov.prepareBallot(token, 1, d);
        bytes32[] memory opts = _options(address(gov), token, 1);
        assertEq(opts.length, 32);
        for (uint256 i; i < opts.length; ++i) {
            for (uint256 j; j < i; ++j) {
                assertTrue(opts[i] != opts[j], "repeat");
            }
        }
    }

    function test_wholePoolInOrderWhenItFitsTheSlots() public {
        // children x Africa alone: 20 entries, walked in order into a 32-option ballot.
        address t2 = makeAddr("t2");
        profiles.register(t2, creator);
        profiles.setFocus(t2, uint64(1) << 3, FOCUS_R);
        vm.prank(factory);
        gov.registerToken(t2);
        scheme.setMaxOptions(32);
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, t2, 1, uint64(1) << 3, FOCUS_R);
        assertEq(d.length, 20);
        gov.prepareBallot(t2, 1, d);
        bytes32[] memory opts = _options(address(gov), t2, 1);
        assertEq(opts.length, 20);
        for (uint256 i; i < 20; ++i) {
            assertEq(opts[i], _causeOf(30 + i));
        }
    }

    function test_blockedOrgsAreSkipped() public {
        IEpochGovernor.Draw[] memory d = _draws(1);
        bytes32 victim = d[0].orgId;
        vm.prank(owner);
        registry.blockOrg(victim);
        IEpochGovernor.Draw[] memory d2 = _draws(1);
        gov.prepareBallot(token, 1, d2);
        bytes32[] memory opts = _options(address(gov), token, 1);
        assertFalse(_contains(opts, keccak256(abi.encode(victim))));
        assertEq(opts.length, 10);
    }

    function test_prepare_rejectsWrongDraws() public {
        IEpochGovernor.Draw[] memory d = _draws(1);
        // Too few.
        IEpochGovernor.Draw[] memory few = new IEpochGovernor.Draw[](3);
        for (uint256 i; i < 3; ++i) {
            few[i] = d[i];
        }
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteBallot.selector, token, 1, 3)
        );
        gov.prepareBallot(token, 1, few);
        // Too many.
        IEpochGovernor.Draw[] memory many = new IEpochGovernor.Draw[](d.length + 1);
        for (uint256 i; i < d.length; ++i) {
            many[i] = d[i];
        }
        many[d.length] = d[0];
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.TooManyDraws.selector, d.length + 1, d.length)
        );
        gov.prepareBallot(token, 1, many);
        // A different (valid) catalogue entry in place of draw 2.
        IEpochGovernor.Draw[] memory swapped = _copy(d);
        swapped[2] = IEpochGovernor.Draw({orgId: cat.entryAt(55).orgId, proof: cat.proofOf(55)});
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidDraw.selector, 2));
        gov.prepareBallot(token, 1, swapped);
        // The right org with a broken proof.
        IEpochGovernor.Draw[] memory broken = _copy(d);
        broken[1].proof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidDraw.selector, 1));
        gov.prepareBallot(token, 1, broken);
        // The correct draws still work.
        gov.prepareBallot(token, 1, d);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.EpochAlreadyOpened.selector, token, 1)
        );
        gov.prepareBallot(token, 1, d);
    }

    function test_newVersionMidEpochOnlyAffectsLaterEpochs() public {
        // Version 2 drops the hunger bucket entirely by publishing 5 fresh children orgs.
        CatalogFixture cat2 = cat; // same fixture: add entries and republish
        for (uint256 i; i < 5; ++i) {
            cat2.add(cat2.bucketOf(3, 0), _org(500 + i));
        }
        vm.warp(gov.epochStart(1) + 1 days);
        cat2.publish();
        (uint32 v, uint256 p) = gov.poolOf(token, 1);
        assertEq(v, 1);
        assertEq(p, 50);
        (v, p) = gov.poolOf(token, 2);
        assertEq(v, 2);
        assertEq(p, 55);
    }

    function test_winnerFromRotationIsMaterializedAndPayable() public {
        gov.prepareBallot(token, 1, _draws(1));
        bytes32[] memory opts = _options(address(gov), token, 1);
        bytes32 winner = opts[4];
        bytes32 winnerOrg = _orgIds(address(gov), token, 1)[4];
        assertFalse(registry.exists(winner));
        vm.prank(voter);
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(4)));
        vm.warp(gov.epochStart(2));
        gov.closeEpoch(token, 1);
        scheme.finalizeFromBallots(address(gov), token, 1);
        gov.finalizeEpoch(token, 1, _orgIds(address(gov), token, 1));
        assertEq(gov.winningCause(token, 1), winner);
        assertTrue(registry.isActive(winner));
        ICauseRegistry.Cause memory c = registry.getCause(winner);
        assertEq(c.orgId, winnerOrg);
        assertEq(c.orgAddress, orgFactory.computeOrgAddress(c.orgId));
        // Losing options were never written to the registry.
        assertFalse(registry.exists(opts[5]));
    }

    function test_gas_prepareBallot() public {
        scheme.setMaxOptions(32);
        IEpochGovernor.Draw[] memory d = _draws(1);
        uint256 before = gasleft();
        gov.prepareBallot(token, 1, d);
        emit log_named_uint(
            "prepareBallot gas, 32 options from a 50-entry pool", before - gasleft()
        );
        emit log_named_uint("draws", d.length);
    }

    function _copy(IEpochGovernor.Draw[] memory d)
        internal
        pure
        returns (IEpochGovernor.Draw[] memory c)
    {
        c = new IEpochGovernor.Draw[](d.length);
        for (uint256 i; i < d.length; ++i) {
            c[i] = IEpochGovernor.Draw({orgId: d[i].orgId, proof: d[i].proof});
        }
    }
}
