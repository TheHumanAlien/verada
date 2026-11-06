// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "../src/interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IERC8004IdentityRegistry} from "../src/interfaces/external/IERC8004IdentityRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";
import {IdentityRegistryMock} from "./mocks/IdentityRegistryMock.sol";
import {CatalogFixture, CatalogTree} from "./utils/CatalogFixture.sol";

/// @dev Profile registry stand-in that also exposes a parent node (for `CuratorRegistry`).
contract ProfilesWithParent is MockProfileRegistryLite {
    bytes32 public constant parentNode = keccak256("parent");
}

/// @notice The curated phase between pins and rotation: weight shares, proofs, skipped picks and
///         fallbacks. Catalogue: 20 orgs in hunger x Africa (bucket 32), 10 in hunger x Asia (33).
///         The token's focus is hunger x {Africa, Asia}; ballots hold 10 options.
contract EpochGovernorCuratedTest is Test {
    uint8 internal constant HUNGER = 2;
    uint16 internal constant AF = 32;
    uint16 internal constant AS = 33;
    uint64 internal constant FOCUS_C = uint64(1) << 2;
    uint16 internal constant FOCUS_R = 3; // Africa and Asia

    CatalogFixture internal cat;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    ProfilesWithParent internal profiles;
    EpochGovernor internal gov;
    CuratorRegistry internal curators;
    IdentityRegistryMock internal identity;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal signer = makeAddr("signer");

    /// @dev Picks per bucket: catalogue index and claimed org, by rank.
    mapping(uint16 bucket => uint32[]) internal _pickIndex;
    mapping(uint16 bucket => bytes32[]) internal _pickOrg;

    function _af(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("af", i));
    }

    function _as(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("as", i));
    }

    function setUp() public {
        vm.warp(1_750_000_123);
        VeradaToken t = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(t);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(10);
        profiles = new ProfilesWithParent();
        identity = new IdentityRegistryMock();

        cat = new CatalogFixture();
        for (uint256 i; i < 20; ++i) {
            cat.add(AF, _af(i)); // entries 0..19, index i
        }
        for (uint256 i; i < 10; ++i) {
            cat.add(AS, _as(i)); // entries 20..29, index i
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
        curators = new CuratorRegistry(
            owner,
            IERC8004IdentityRegistry(address(identity)),
            ICauseCatalog(address(cat.catalog())),
            ICauseRegistry(address(registry)),
            IEndaomentOrgFundFactory(address(orgFactory)),
            IERC20(address(usdc)),
            ITokenProfileRegistry(address(profiles))
        );
        profiles.register(token, creator);
        profiles.setFocus(token, FOCUS_C, FOCUS_R);
        vm.startPrank(owner);
        gov.setFactory(factory);
        gov.setCuratorRegistry(ICuratorRegistry(address(curators)));
        registry.setMaterializer(address(gov), true);
        curators.setGovernor(IEpochGovernor(address(gov)));
        curators.registerAgent(HUNGER, "hunger", signer, "", "");
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
    }

    // ---- helpers

    function _setPicks(uint16 bucket, uint32[] memory idx, bytes32[] memory orgs) internal {
        delete _pickIndex[bucket];
        delete _pickOrg[bucket];
        for (uint256 i; i < idx.length; ++i) {
            _pickIndex[bucket].push(idx[i]);
            _pickOrg[bucket].push(orgs[i]);
        }
    }

    /// @dev Picks the last `n` entries of a bucket in reverse order (rank 0 = the last entry).
    function _reversePicks(uint16 bucket, uint256 n, uint256 size) internal {
        uint32[] memory idx = new uint32[](n);
        bytes32[] memory orgs = new bytes32[](n);
        for (uint256 r; r < n; ++r) {
            // forge-lint: disable-next-line(unsafe-typecast)
            idx[r] = uint32(size - 1 - r);
            orgs[r] = bucket == AF ? _af(size - 1 - r) : _as(size - 1 - r);
        }
        _setPicks(bucket, idx, orgs);
    }

    function _pickLeaves(uint16 bucket) internal view returns (bytes32[] memory leaves) {
        uint256 n = _pickIndex[bucket].length;
        leaves = new bytes32[](n);
        for (uint256 r; r < n; ++r) {
            leaves[r] = keccak256(
                bytes.concat(
                    keccak256(abi.encode(uint8(r), _pickIndex[bucket][r], _pickOrg[bucket][r]))
                )
            );
        }
    }

    /// @dev Submits both buckets' current picks for epoch 1 with the given weights.
    function _submit(uint16 wAf, uint16 wAs) internal {
        ICuratorRegistry.CurationInput[] memory c = new ICuratorRegistry.CurationInput[](2);
        // forge-lint: disable-next-line(unsafe-typecast)
        c[0] = ICuratorRegistry.CurationInput(
            0, CatalogTree.root(_pickLeaves(AF)), uint8(_pickIndex[AF].length), wAf
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        c[1] = ICuratorRegistry.CurationInput(
            1, CatalogTree.root(_pickLeaves(AS)), uint8(_pickIndex[AS].length), wAs
        );
        vm.prank(signer);
        curators.submitCurations(HUNGER, 1, 1, bytes32("report"), c);
    }

    /// @dev The curated draws for quotas `(qAf, qAs)`: pick leaf + proof and the true catalogue
    ///      entry at the claimed index + its proof.
    function _curated(uint256 qAf, uint256 qAs)
        internal
        view
        returns (IEpochGovernor.CuratedDraw[] memory d)
    {
        d = new IEpochGovernor.CuratedDraw[](qAf + qAs);
        uint256 k;
        for (uint256 b; b < 2; ++b) {
            uint16 bucket = b == 0 ? AF : AS;
            uint256 q = b == 0 ? qAf : qAs;
            bytes32[] memory leaves = _pickLeaves(bucket);
            for (uint256 r; r < q; ++r) {
                uint32 index = _pickIndex[bucket][r];
                IEpochGovernor.CuratedDraw memory x;
                x.catalogIndex = index;
                x.pickOrgId = _pickOrg[bucket][r];
                x.pickProof = CatalogTree.proof(leaves, r);
                if (index < (bucket == AF ? 20 : 10)) {
                    uint256 e = cat.find(bucket, index);
                    x.entryOrgId = cat.entryAt(e).orgId;
                    x.entryProof = cat.proofOf(e);
                }
                d[k++] = x;
            }
        }
    }

    function _toEpoch1() internal {
        vm.warp(gov.epochStart(1));
    }

    function _cause(bytes32 orgId) internal pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    // ---- tests

    function test_curatedPicks_splitTheBallotByWeight() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        _toEpoch1();
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.CuratedPicksUsed(token, 1, 10, 10);
        gov.prepareCuratedBallot(token, 1, _curated(6, 4), new IEpochGovernor.Draw[](0));
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 10);
        for (uint256 r; r < 6; ++r) {
            assertEq(opts[r], _cause(_af(19 - r)), "Africa ranks first");
        }
        for (uint256 r; r < 4; ++r) {
            assertEq(opts[6 + r], _cause(_as(9 - r)), "then Asia");
        }
        assertTrue(gov.isOpened(token, 1));
    }

    function test_pinsFirst_thenCuratedShares() public {
        IEpochGovernor.Pin[] memory pins = new IEpochGovernor.Pin[](2);
        pins[0] = cat.pin(0);
        pins[1] = cat.pin(1);
        vm.prank(creator);
        gov.setShortlist(token, pins);
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        _toEpoch1();
        // 8 free slots: floor(4.8) = 4 and floor(3.2) = 3, the leftover to Africa.
        gov.prepareCuratedBallot(token, 1, _curated(5, 3), new IEpochGovernor.Draw[](0));
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts[0], _cause(_af(0)));
        assertEq(opts[1], _cause(_af(1)));
        assertEq(opts[2], _cause(_af(19)));
        assertEq(opts.length, 10);
    }

    function test_provablyWrongPick_isSkipped_andRotationFills() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        // Africa rank 1 claims entry 18 is an Asian org.
        _pickOrg[AF][1] = _as(0);
        _submit(6000, 4000);
        _toEpoch1();
        IEpochGovernor.CuratedDraw[] memory c = _curated(6, 4);
        bytes32[] memory taken = new bytes32[](9);
        uint256 n;
        for (uint256 r; r < 6; ++r) {
            if (r != 1) taken[n++] = _cause(_af(19 - r));
        }
        for (uint256 r; r < 4; ++r) {
            taken[n++] = _cause(_as(9 - r));
        }
        IEpochGovernor.Draw[] memory d =
            cat.drawsAfter(gov, registry, token, 1, FOCUS_C, FOCUS_R, taken);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.CuratedPicksUsed(token, 1, 10, 9);
        gov.prepareCuratedBallot(token, 1, c, d);
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 10);
        for (uint256 i; i < opts.length; ++i) {
            assertTrue(
                opts[i] != _cause(_as(0)) || i >= 9, "the wrong claim never enters as a pick"
            );
        }
    }

    function test_pickPastTheBucket_isSkipped() public {
        uint32[] memory idx = new uint32[](2);
        bytes32[] memory orgs = new bytes32[](2);
        idx[0] = 99;
        orgs[0] = bytes32("ghost");
        idx[1] = 3;
        orgs[1] = _af(3);
        _setPicks(AF, idx, orgs);
        _reversePicks(AS, 1, 10);
        _submit(5000, 5000);
        _toEpoch1();
        // Quotas: Africa 2 (all its picks), Asia 1, so 7 slots go to rotation.
        IEpochGovernor.CuratedDraw[] memory c = _curated(2, 1);
        bytes32[] memory taken = new bytes32[](2);
        taken[0] = _cause(_af(3));
        taken[1] = _cause(_as(9));
        IEpochGovernor.Draw[] memory d =
            cat.drawsAfter(gov, registry, token, 1, FOCUS_C, FOCUS_R, taken);
        gov.prepareCuratedBallot(token, 1, c, d);
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts[0], _cause(_af(3)));
        assertEq(opts[1], _cause(_as(9)));
        assertEq(opts.length, 10);
    }

    function test_blockedPick_isSkipped() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        vm.prank(owner);
        registry.blockOrg(_af(19));
        _toEpoch1();
        bytes32[] memory taken = new bytes32[](9);
        uint256 n;
        for (uint256 r = 1; r < 6; ++r) {
            taken[n++] = _cause(_af(19 - r));
        }
        for (uint256 r; r < 4; ++r) {
            taken[n++] = _cause(_as(9 - r));
        }
        IEpochGovernor.Draw[] memory d =
            cat.drawsAfter(gov, registry, token, 1, FOCUS_C, FOCUS_R, taken);
        gov.prepareCuratedBallot(token, 1, _curated(6, 4), d);
        bytes32[] memory opts = gov.epochOptions(token, 1);
        for (uint256 i; i < opts.length; ++i) {
            assertTrue(opts[i] != _cause(_af(19)));
        }
    }

    function test_curatedDraws_areRequired_andChecked() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        _toEpoch1();
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteCuratedBallot.selector, token, 1, 0)
        );
        gov.prepareBallot(token, 1, new IEpochGovernor.Draw[](0));
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteCuratedBallot.selector, token, 1, 0)
        );
        gov.openEpoch(token, 1);

        IEpochGovernor.CuratedDraw[] memory c = _curated(6, 4);
        c[0].pickProof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidCuratedDraw.selector, 0));
        gov.prepareCuratedBallot(token, 1, c, new IEpochGovernor.Draw[](0));

        c = _curated(6, 4);
        c[7].entryOrgId = bytes32("forged");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidCuratedDraw.selector, 7));
        gov.prepareCuratedBallot(token, 1, c, new IEpochGovernor.Draw[](0));

        IEpochGovernor.CuratedDraw[] memory few = new IEpochGovernor.CuratedDraw[](9);
        IEpochGovernor.CuratedDraw[] memory all = _curated(6, 4);
        for (uint256 i; i < 9; ++i) {
            few[i] = all[i];
        }
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteCuratedBallot.selector, token, 1, 9)
        );
        gov.prepareCuratedBallot(token, 1, few, new IEpochGovernor.Draw[](0));

        IEpochGovernor.CuratedDraw[] memory many = new IEpochGovernor.CuratedDraw[](11);
        for (uint256 i; i < 10; ++i) {
            many[i] = all[i];
        }
        many[10] = all[0];
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TooManyCuratedDraws.selector, 11, 10));
        gov.prepareCuratedBallot(token, 1, many, new IEpochGovernor.Draw[](0));
    }

    function test_afterTheGrace_unpublishedPicksFallBackToRotation() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        _toEpoch1();
        vm.warp(gov.epochStart(1) + gov.CURATION_GRACE() - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteCuratedBallot.selector, token, 1, 0)
        );
        gov.prepareBallot(token, 1, new IEpochGovernor.Draw[](0));
        vm.warp(gov.epochStart(1) + gov.CURATION_GRACE());
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, FOCUS_C, FOCUS_R);
        gov.prepareBallot(token, 1, d);
        assertEq(gov.epochOptions(token, 1).length, 10);
    }

    function test_afterTheGrace_curatedDrawsStillApply() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        vm.warp(gov.epochStart(1) + gov.CURATION_GRACE() + 1);
        IEpochGovernor.CuratedDraw[] memory c = _curated(6, 4);
        gov.prepareCuratedBallot(token, 1, c, new IEpochGovernor.Draw[](0));
        assertEq(gov.epochOptions(token, 1).length, 10);
        assertEq(gov.epochOptions(token, 1)[0], _cause(_af(19)), "rank 0 of Africa leads");
    }

    function test_pausedAgent_fallsBackToRotation() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        vm.prank(owner);
        curators.setActive(HUNGER, false);
        _toEpoch1();
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, FOCUS_C, FOCUS_R);
        gov.prepareBallot(token, 1, d);
        assertEq(gov.epochOptions(token, 1).length, 10);
    }

    function test_newCatalogueVersion_voidsTheCuration() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        // Version 2 is set before epoch 1 starts, so epoch 1 uses it and the curation (version 1)
        // no longer applies.
        cat.add(AF, _af(20));
        cat.publish();
        _toEpoch1();
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, FOCUS_C, FOCUS_R);
        gov.prepareBallot(token, 1, d);
        assertEq(gov.epochOptions(token, 1).length, 10);
    }

    function test_curationForAnotherEpoch_isIgnored() public {
        _reversePicks(AF, 8, 20);
        _reversePicks(AS, 4, 10);
        _submit(6000, 4000);
        vm.warp(gov.epochStart(2));
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 2, FOCUS_C, FOCUS_R);
        gov.prepareBallot(token, 2, d);
        assertEq(gov.epochOptions(token, 2).length, 10);
    }

    function test_gas_prepareCuratedBallot_32() public {
        scheme.setMaxOptions(32);
        _reversePicks(AF, 20, 20);
        _reversePicks(AS, 10, 10);
        _submit(6000, 4000);
        _toEpoch1();
        IEpochGovernor.CuratedDraw[] memory c = _curated(20, 10);
        bytes32[] memory taken = new bytes32[](30);
        uint256 n;
        for (uint256 r; r < 20; ++r) {
            taken[n++] = _cause(_af(19 - r));
        }
        for (uint256 r; r < 10; ++r) {
            taken[n++] = _cause(_as(9 - r));
        }
        IEpochGovernor.Draw[] memory d =
            cat.drawsAfter(gov, registry, token, 1, FOCUS_C, FOCUS_R, taken);
        uint256 before = gasleft();
        gov.prepareCuratedBallot(token, 1, c, d);
        emit log_named_uint(
            "prepareCuratedBallot gas, 30 curated + rotation, 32 options", before - gasleft()
        );
        assertEq(gov.epochOptions(token, 1).length, 30, "pool of 30 orgs: all of them");
    }
}
