// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {LabelGen} from "../utils/LabelGen.sol";

/// @dev External wrapper so reverts can be caught with `vm.expectRevert` and `try/catch`.
contract DnsNameLibHarness {
    function readLabel(bytes memory name, uint256 offset) external pure returns (bytes32, uint256) {
        return DnsNameLib.readLabel(name, offset);
    }

    function namehash(bytes memory name, uint256 offset) external pure returns (bytes32) {
        return DnsNameLib.namehash(name, offset);
    }

    function encode(string memory dotted) external pure returns (bytes memory) {
        return DnsNameLib.encode(dotted);
    }
}

contract DnsNameLibTest is Test {
    DnsNameLibHarness internal lib;

    // Reference values (viem `namehash`, ENS docs).
    bytes32 internal constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;
    bytes32 internal constant VERADA_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;
    bytes32 internal constant PEPE_VERADA_NODE =
        0x1d5d7832f3d8c36e3cd2f591b85b37bb1cfdc47fa841737d9e1632e10689c782;

    bytes internal constant VERADA_DNS = hex"0676617261646103657468" hex"00";

    function setUp() public {
        lib = new DnsNameLibHarness();
    }

    /// @dev Recursive definition of namehash over a dotted string, independent of the library.
    function _refNamehash(string memory dotted) internal pure returns (bytes32) {
        bytes memory s = bytes(dotted);
        if (s.length == 0) return bytes32(0);
        uint256 dot = s.length;
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == ".") {
                dot = i;
                break;
            }
        }
        bytes memory label = new bytes(dot);
        for (uint256 i; i < dot; ++i) {
            label[i] = s[i];
        }
        bytes memory rest = new bytes(dot == s.length ? 0 : s.length - dot - 1);
        for (uint256 i; i < rest.length; ++i) {
            rest[i] = s[dot + 1 + i];
        }
        return keccak256(abi.encodePacked(_refNamehash(string(rest)), keccak256(label)));
    }

    // ------------------------------------------------------------------ encode

    function test_encode_veradaEth() public view {
        bytes memory enc = lib.encode("varada.eth");
        assertEq(enc, VERADA_DNS);
        assertEq(enc.length, 12);
        assertEq(uint8(enc[0]), 6);
        assertEq(uint8(enc[7]), 3);
        assertEq(uint8(enc[11]), 0);
    }

    function test_encode_root() public view {
        assertEq(lib.encode(""), hex"00");
    }

    function test_encode_singleLabel() public view {
        assertEq(lib.encode("eth"), hex"0365746800");
    }

    function test_encode_maxLabel() public view {
        bytes memory label = new bytes(63);
        for (uint256 i; i < 63; ++i) {
            label[i] = "a";
        }
        bytes memory enc = lib.encode(string(label));
        assertEq(enc.length, 65);
        assertEq(uint8(enc[0]), 63);
        assertEq(uint8(enc[64]), 0);
    }

    function test_encode_rejectsEmptyLabel() public {
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bytes("a..b")));
        lib.encode("a..b");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bytes(".eth")));
        lib.encode(".eth");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bytes("eth.")));
        lib.encode("eth.");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bytes(".")));
        lib.encode(".");
    }

    function test_encode_rejectsLongLabel() public {
        bytes memory label = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            label[i] = "a";
        }
        string memory dotted = string.concat(string(label), ".eth");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bytes(dotted)));
        lib.encode(dotted);
    }

    // ------------------------------------------------------------------ namehash

    function test_namehash_root() public view {
        assertEq(lib.namehash(hex"00", 0), bytes32(0));
    }

    function test_namehash_eth() public view {
        assertEq(lib.namehash(lib.encode("eth"), 0), ETH_NODE);
        assertEq(
            ETH_NODE,
            keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))),
            "eth node definition"
        );
    }

    function test_namehash_veradaEth() public view {
        bytes32 node = lib.namehash(VERADA_DNS, 0);
        assertEq(node, VERADA_NODE, "viem reference");
        assertEq(node, _refNamehash("varada.eth"), "recursive reference");
        assertEq(
            node,
            keccak256(
                abi.encodePacked(
                    keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))), keccak256("varada")
                )
            ),
            "hardcoded definition"
        );
    }

    function test_namehash_pepeVaradaEth() public view {
        bytes memory enc = lib.encode("pepe.varada.eth");
        assertEq(lib.namehash(enc, 0), PEPE_VERADA_NODE);
        assertEq(lib.namehash(enc, 0), _refNamehash("pepe.varada.eth"));
        assertEq(lib.namehash(enc, 0), keccak256(abi.encodePacked(VERADA_NODE, keccak256("pepe"))));
        // Offset 5 skips the first label: the remainder is varada.eth.
        assertEq(lib.namehash(enc, 5), VERADA_NODE);
    }

    function test_namehash_rejectsMissingTerminator() public {
        bytes memory name = hex"0470657065"; // \x04pepe without the trailing 0
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.namehash(name, 0);
    }

    function test_namehash_rejectsTrailingBytes() public {
        bytes memory name = hex"00ff";
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.namehash(name, 0);
        name = abi.encodePacked(VERADA_DNS, hex"00");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.namehash(name, 0);
    }

    function test_namehash_rejectsLengthOverflow() public {
        bytes memory name = hex"05616263"; // claims 5 bytes, has 3
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.namehash(name, 0);
    }

    function test_namehash_rejectsEmpty() public {
        bytes memory name = "";
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.namehash(name, 0);
    }

    function test_namehash_rejectsOffsetPastEnd() public {
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, VERADA_DNS));
        lib.namehash(VERADA_DNS, 12);
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, VERADA_DNS));
        lib.namehash(VERADA_DNS, 100);
    }

    // ------------------------------------------------------------------ readLabel

    function test_readLabel() public view {
        (bytes32 labelhash, uint256 next) = lib.readLabel(VERADA_DNS, 0);
        assertEq(labelhash, keccak256("varada"));
        assertEq(next, 7);
        (labelhash, next) = lib.readLabel(VERADA_DNS, 7);
        assertEq(labelhash, keccak256("eth"));
        assertEq(next, 11);
        (labelhash, next) = lib.readLabel(VERADA_DNS, 11);
        assertEq(labelhash, bytes32(0));
        assertEq(next, 12);
    }

    function test_readLabel_rejectsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, VERADA_DNS));
        lib.readLabel(VERADA_DNS, 12);
        bytes memory name = hex"05616263";
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, name));
        lib.readLabel(name, 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev `encode` followed by `namehash` equals the recursive definition over the dotted
    ///      string for any one, two or three labels.
    function testFuzz_roundTrip(bytes32 s1, bytes32 s2, bytes32 s3, uint8 l1, uint8 l2, uint8 l3)
        public
        view
    {
        string memory a = LabelGen.valid(s1, l1);
        string memory b = LabelGen.valid(s2, l2);
        string memory c = LabelGen.valid(s3, l3);
        string memory one = a;
        string memory two = string.concat(a, ".", b);
        string memory three = string.concat(a, ".", b, ".", c);
        assertEq(lib.namehash(lib.encode(one), 0), _refNamehash(one));
        assertEq(lib.namehash(lib.encode(two), 0), _refNamehash(two));
        assertEq(lib.namehash(lib.encode(three), 0), _refNamehash(three));
        // Hashing from the second label's offset yields the namehash of the suffix name.
        bytes memory encThree = lib.encode(three);
        assertEq(
            lib.namehash(encThree, bytes(a).length + 1), _refNamehash(string.concat(b, ".", c))
        );
        assertEq(lib.namehash(encThree, bytes(a).length + bytes(b).length + 2), _refNamehash(c));
    }

    /// @dev The encoding of `<label>.varada.eth` is the label prefix followed by the parent.
    function testFuzz_encodeUnderParent(bytes32 seed, uint8 len) public view {
        string memory label = LabelGen.valid(seed, len);
        bytes memory enc = lib.encode(string.concat(label, ".varada.eth"));
        assertEq(
            enc, abi.encodePacked(bytes1(uint8(bytes(label).length)), bytes(label), VERADA_DNS)
        );
        assertEq(
            lib.namehash(enc, 0), keccak256(abi.encodePacked(VERADA_NODE, keccak256(bytes(label))))
        );
    }

    /// @dev Revert selector of `err` (a panic would be 0x4e487b71).
    function _selector(bytes memory err) internal pure returns (bytes4) {
        // only the selector is wanted
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(err);
    }

    /// @dev Random bytes either hash or revert with `InvalidDnsName`; never a panic.
    function testFuzz_randomBytesNeverPanic(bytes memory raw, uint8 offset) public view {
        try lib.namehash(raw, offset) returns (bytes32) {}
        catch (bytes memory err) {
            assertEq(_selector(err), DnsNameLib.InvalidDnsName.selector);
        }
        try lib.readLabel(raw, offset) returns (bytes32, uint256) {}
        catch (bytes memory err) {
            assertEq(_selector(err), DnsNameLib.InvalidDnsName.selector);
        }
    }

    /// @dev Random dotted strings either encode (and then hash) or revert with `InvalidDnsName`.
    function testFuzz_randomDottedNeverPanic(string memory dotted) public view {
        try lib.encode(dotted) returns (bytes memory enc) {
            assertEq(lib.namehash(enc, 0), _refNamehash(dotted));
        } catch (bytes memory err) {
            assertEq(_selector(err), DnsNameLib.InvalidDnsName.selector);
        }
    }
}
