// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseCatalog} from "../src/CauseCatalog.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {CatalogTree} from "./utils/CatalogFixture.sol";

contract CauseCatalogTest is Test {
    CauseCatalog internal catalog;
    address internal owner = makeAddr("owner");

    uint16 internal constant HUNGER_AF = 2 * 16 + 0;
    uint16 internal constant HUNGER_NA = 2 * 16 + 4;
    uint16 internal constant KIDS_AF = 3 * 16 + 0;
    uint64 internal constant HUNGER = uint64(1) << 2;
    uint64 internal constant KIDS = uint64(1) << 3;
    uint16 internal constant AFRICA = uint16(1) << 0;
    uint16 internal constant NORTH_AMERICA = uint16(1) << 4;

    bytes32[] internal leaves;
    uint32[] internal sizes;

    function setUp() public {
        vm.warp(1_750_000_000);
        catalog = new CauseCatalog(owner);
        sizes = new uint32[](320);
        _entry(HUNGER_AF, "a0");
        _entry(HUNGER_AF, "a1");
        _entry(HUNGER_AF, "a2");
        _entry(HUNGER_NA, "n0");
        _entry(KIDS_AF, "k0");
        _entry(KIDS_AF, "k1");
    }

    function _entry(uint16 bucket, bytes32 orgId) internal {
        leaves.push(catalog.leafHash(bucket, sizes[bucket]++, orgId));
    }

    function _publish() internal returns (uint32) {
        vm.prank(owner);
        return catalog.setVersion(CatalogTree.root(leaves), sizes, bytes32("swarm"));
    }

    function test_setVersion_storesAndEmits() public {
        bytes32 root = CatalogTree.root(leaves);
        vm.expectEmit(true, false, false, true);
        emit ICauseCatalog.CatalogVersionSet(1, root, bytes32("swarm"), 6, uint64(block.timestamp));
        assertEq(_publish(), 1);
        assertEq(catalog.latestVersion(), 1);
        assertEq(catalog.rootOf(1), root);
        assertEq(catalog.swarmRefOf(1), bytes32("swarm"));
        assertEq(catalog.setAtOf(1), block.timestamp);
        assertEq(catalog.bucketSizesOf(1).length, 320);
        assertEq(catalog.bucketSizesOf(1)[HUNGER_AF], 3);
        assertEq(catalog.REGION_SLOTS(), 16);
    }

    function test_setVersion_guards() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        catalog.setVersion(bytes32(uint256(1)), sizes, 0);
        vm.startPrank(owner);
        vm.expectRevert(ICauseCatalog.ZeroRoot.selector);
        catalog.setVersion(0, sizes, 0);
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.InvalidBucketCount.selector, 0));
        catalog.setVersion(bytes32(uint256(1)), new uint32[](0), 0);
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.InvalidBucketCount.selector, 17));
        catalog.setVersion(bytes32(uint256(1)), new uint32[](17), 0);
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.InvalidBucketCount.selector, 1040));
        catalog.setVersion(bytes32(uint256(1)), new uint32[](1040), 0);
        catalog.setVersion(bytes32(uint256(1)), new uint32[](1024), 0);
        vm.stopPrank();
    }

    function test_unknownVersionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.UnknownVersion.selector, 0));
        catalog.rootOf(0);
        _publish();
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.UnknownVersion.selector, 2));
        catalog.bucketSizesOf(2);
        assertEq(catalog.poolSize(0, HUNGER, AFRICA), 0);
    }

    function test_versionAt_isStrictlyBefore() public {
        assertEq(catalog.versionAt(block.timestamp), 0);
        uint256 t1 = block.timestamp;
        _publish();
        assertEq(catalog.versionAt(t1), 0, "same second does not count");
        assertEq(catalog.versionAt(t1 + 1), 1);
        vm.warp(t1 + 100);
        _publish();
        _publish(); // two versions in the same second: the later wins
        assertEq(catalog.versionAt(t1 + 100), 1);
        assertEq(catalog.versionAt(t1 + 101), 3);
        assertEq(catalog.versionAt(type(uint256).max), 3);
    }

    function test_focus_poolAndLocate() public {
        _publish();
        assertTrue(catalog.inFocus(HUNGER_AF, HUNGER, AFRICA));
        assertFalse(catalog.inFocus(HUNGER_NA, HUNGER, AFRICA));
        assertFalse(catalog.inFocus(KIDS_AF, HUNGER, AFRICA));
        assertEq(catalog.poolSize(1, HUNGER, AFRICA), 3);
        assertEq(catalog.poolSize(1, HUNGER | KIDS, AFRICA), 5);
        assertEq(catalog.poolSize(1, HUNGER, AFRICA | NORTH_AMERICA), 4);
        assertEq(catalog.poolSize(1, type(uint64).max, type(uint16).max), 6);
        assertEq(catalog.poolSize(1, KIDS, NORTH_AMERICA), 0);

        (uint16[] memory buckets, uint32[] memory s) =
            catalog.focusBuckets(1, HUNGER | KIDS, AFRICA | NORTH_AMERICA);
        assertEq(buckets.length, 3);
        assertEq(buckets[0], HUNGER_AF);
        assertEq(buckets[1], HUNGER_NA);
        assertEq(buckets[2], KIDS_AF);
        assertEq(s[2], 2);

        uint64 cm = HUNGER | KIDS;
        uint16 rm = AFRICA | NORTH_AMERICA;
        (uint16 b, uint32 i) = catalog.locate(1, cm, rm, 0);
        assertEq(b, HUNGER_AF);
        assertEq(i, 0);
        (b, i) = catalog.locate(1, cm, rm, 3);
        assertEq(b, HUNGER_NA);
        assertEq(i, 0);
        (b, i) = catalog.locate(1, cm, rm, 5);
        assertEq(b, KIDS_AF);
        assertEq(i, 1);
        vm.expectRevert(abi.encodeWithSelector(ICauseCatalog.PoolIndexOutOfRange.selector, 6, 6));
        catalog.locate(1, cm, rm, 6);
    }

    function test_inFocus_ignoresCategoryBitsPastSixtyFour() public view {
        assertFalse(catalog.inFocus(64 * 16, type(uint64).max, type(uint16).max));
    }

    function test_verify() public {
        _publish();
        for (uint256 i; i < leaves.length; ++i) {
            bytes32[] memory proof = CatalogTree.proof(leaves, i);
            (uint16 bucket, uint32 index, bytes32 orgId) = _entryAt(i);
            assertTrue(catalog.verify(1, bucket, index, orgId, proof), "valid entry");
            assertFalse(catalog.verify(1, bucket, index, bytes32("other"), proof), "wrong org");
            assertFalse(catalog.verify(1, bucket, index + 1, orgId, proof), "wrong index");
        }
        // An index past the bucket's size is rejected before the proof is checked.
        assertFalse(catalog.verify(1, HUNGER_AF, 3, "a0", CatalogTree.proof(leaves, 0)));
        assertFalse(catalog.verify(1, 1000, 0, "a0", CatalogTree.proof(leaves, 0)));
    }

    function test_leafHash_isOpenZeppelinStandardLeaf() public view {
        bytes32 expected = keccak256(
            bytes.concat(keccak256(abi.encode(uint16(HUNGER_AF), uint32(7), bytes32("org"))))
        );
        assertEq(catalog.leafHash(HUNGER_AF, 7, "org"), expected);
    }

    /// @dev Entry `i` in the order `setUp` added them.
    function _entryAt(uint256 i) internal pure returns (uint16, uint32, bytes32) {
        if (i == 0) return (HUNGER_AF, 0, "a0");
        if (i == 1) return (HUNGER_AF, 1, "a1");
        if (i == 2) return (HUNGER_AF, 2, "a2");
        if (i == 3) return (HUNGER_NA, 0, "n0");
        if (i == 4) return (KIDS_AF, 0, "k0");
        return (KIDS_AF, 1, "k1");
    }
}
