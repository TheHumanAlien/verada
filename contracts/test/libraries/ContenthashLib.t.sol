// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {ContenthashLib} from "../../src/libraries/ContenthashLib.sol";

contract ContenthashLibTest is Test {
    bytes32 internal constant REF =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    bytes7 internal constant PREFIX = hex"e40101fa011b20";

    function test_constants() public pure {
        assertEq(ContenthashLib.SWARM_PREFIX, PREFIX);
        assertEq(ContenthashLib.SWARM_LENGTH, 39);
    }

    function test_swarm_layout() public pure {
        bytes memory h = ContenthashLib.swarm(REF);
        assertEq(h.length, 39);
        // the first seven bytes are the prefix under test
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes7(h), PREFIX);
        // Namespace, CIDv1, swarm-manifest varint, keccak-256 multihash, 32-byte length.
        assertEq(uint8(h[0]), 0xe4);
        assertEq(uint8(h[1]), 0x01);
        assertEq(uint8(h[2]), 0x01);
        assertEq(uint8(h[3]), 0xfa);
        assertEq(uint8(h[4]), 0x01);
        assertEq(uint8(h[5]), 0x1b);
        assertEq(uint8(h[6]), 0x20);
        bytes32 tail;
        for (uint256 i; i < 32; ++i) {
            tail |= bytes32(h[7 + i]) >> (8 * i);
        }
        assertEq(tail, REF);
        assertEq(h, abi.encodePacked(hex"e40101fa011b20", REF));
    }

    function test_isSwarm() public pure {
        assertTrue(ContenthashLib.isSwarm(ContenthashLib.swarm(REF)));
        assertTrue(ContenthashLib.isSwarm(ContenthashLib.swarm(bytes32(0))));
        assertFalse(ContenthashLib.isSwarm(""), "empty");
        assertFalse(ContenthashLib.isSwarm(hex"e40101fa011b20"), "prefix only");
        // IPFS CIDv1 dag-pb sha2-256 (ipfs-ns 0xe3), same total length.
        assertFalse(
            ContenthashLib.isSwarm(abi.encodePacked(hex"e30101701220", REF, bytes1(0))), "ipfs"
        );
        // Right length, wrong multihash code.
        assertFalse(ContenthashLib.isSwarm(abi.encodePacked(hex"e40101fa011220", REF)), "sha256");
        // One byte short / long.
        bytes memory h = ContenthashLib.swarm(REF);
        assertFalse(ContenthashLib.isSwarm(abi.encodePacked(h, bytes1(0))), "too long");
        bytes memory short = new bytes(38);
        for (uint256 i; i < 38; ++i) {
            short[i] = h[i];
        }
        assertFalse(ContenthashLib.isSwarm(short), "too short");
    }

    function testFuzz_swarmRoundTrip(bytes32 ref) public pure {
        bytes memory h = ContenthashLib.swarm(ref);
        assertEq(h.length, 39);
        assertTrue(ContenthashLib.isSwarm(h));
        assertEq(h, abi.encodePacked(ContenthashLib.SWARM_PREFIX, ref));
    }

    function testFuzz_otherPrefixesRejected(bytes7 prefix, bytes32 ref) public pure {
        vm.assume(prefix != ContenthashLib.SWARM_PREFIX);
        assertFalse(ContenthashLib.isSwarm(abi.encodePacked(prefix, ref)));
    }

    function testFuzz_otherLengthsRejected(bytes memory tail) public pure {
        vm.assume(tail.length != 32);
        assertFalse(ContenthashLib.isSwarm(abi.encodePacked(ContenthashLib.SWARM_PREFIX, tail)));
    }
}
