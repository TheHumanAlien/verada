// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {LabelLib} from "../../src/libraries/LabelLib.sol";
import {LabelGen} from "../utils/LabelGen.sol";

/// @dev External wrapper so reverts can be caught with `vm.expectRevert`.
contract LabelLibHarness {
    function validate(string memory label) external pure returns (bytes32) {
        return LabelLib.validate(label);
    }

    function isValid(string memory label) external pure returns (bool) {
        return LabelLib.isValid(label);
    }
}

contract LabelLibTest is Test {
    LabelLibHarness internal lib;

    function setUp() public {
        lib = new LabelLibHarness();
    }

    function _repeat(bytes1 c, uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = c;
        }
        return string(b);
    }

    // ------------------------------------------------------------------ rules

    function test_constants() public pure {
        assertEq(LabelLib.MIN_LENGTH, 3);
        assertEq(LabelLib.MAX_LENGTH, 63);
    }

    function test_length() public view {
        assertFalse(lib.isValid(""));
        assertFalse(lib.isValid("a"));
        assertFalse(lib.isValid("ab"));
        assertTrue(lib.isValid("abc"));
        assertTrue(lib.isValid(_repeat("a", 63)));
        assertFalse(lib.isValid(_repeat("a", 64)));
        assertFalse(lib.isValid(_repeat("a", 200)));
    }

    function test_alphabet() public view {
        assertTrue(lib.isValid("abcdefghijklmnopqrstuvwxyz"));
        assertTrue(lib.isValid("0123456789"));
        assertTrue(lib.isValid("pepe-2024"));
        assertFalse(lib.isValid("Pepe"), "uppercase");
        assertFalse(lib.isValid("PEPE"), "uppercase");
        assertFalse(lib.isValid("pe pe"), "space");
        assertFalse(lib.isValid("pe_pe"), "underscore");
        assertFalse(lib.isValid("pe.pe"), "dot");
        assertFalse(lib.isValid(unicode"pepé"), "non-ascii");
        assertFalse(lib.isValid(unicode"🐸🐸🐸"), "emoji");
        assertFalse(lib.isValid(string(abi.encodePacked("pep", bytes1(0x00)))), "nul");
        assertFalse(lib.isValid(string(abi.encodePacked("pep", bytes1(0x7f)))), "del");
        assertFalse(lib.isValid(string(abi.encodePacked("pep", bytes1(0xff)))), "high byte");
    }

    function test_hyphens() public view {
        assertFalse(lib.isValid("-pepe"), "leading");
        assertFalse(lib.isValid("pepe-"), "trailing");
        assertFalse(lib.isValid("-pepe-"), "both");
        assertFalse(lib.isValid("---"), "all hyphens");
        assertTrue(lib.isValid("pe-pe"), "inner");
        assertTrue(lib.isValid("p-e-p-e"), "many inner");
        assertTrue(lib.isValid("pep--pe"), "run not at 3-4");
        assertTrue(lib.isValid("pepe---pepe"), "longer run not at 3-4");
    }

    function test_hyphensAtPositionsThreeAndFour() public view {
        // b[2] == '-' && b[3] == '-' is the punycode slot and is rejected.
        assertFalse(lib.isValid("ab--c"));
        assertFalse(lib.isValid("xn--abc"));
        assertFalse(lib.isValid("ab--"), "would also fail the trailing rule");
        assertFalse(lib.isValid("ab--cdef"));
        // Hyphen pairs anywhere else are fine.
        assertTrue(lib.isValid("a--bc"));
        assertTrue(lib.isValid("abc--d"));
        assertTrue(lib.isValid("abcd--e"));
        assertTrue(lib.isValid("a-b-c"));
        // Only one of the two positions hyphenated is fine.
        assertTrue(lib.isValid("ab-cd"));
        assertTrue(lib.isValid("abc-d"));
    }

    // ------------------------------------------------------------------ validate

    function test_validate_returnsLabelhash() public view {
        assertEq(lib.validate("pepe"), keccak256("pepe"));
        assertEq(
            lib.validate("pepe"), 0x5d533775be30959f4e2d96c968120ecf6c1f1036d20bc316b593721385f1c1e3
        );
    }

    function test_validate_revertsWithLabel() public {
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "Pepe"));
        lib.validate("Pepe");
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "ab"));
        lib.validate("ab");
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "-ab"));
        lib.validate("-ab");
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "ab--c"));
        lib.validate("ab--c");
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_generatedLabelsAccepted(bytes32 seed, uint8 lenRaw) public view {
        string memory label = LabelGen.valid(seed, lenRaw);
        assertTrue(lib.isValid(label));
        assertEq(lib.validate(label), keccak256(bytes(label)));
        assertTrue(LabelGen.isValidReference(bytes(label)));
    }

    function testFuzz_invalidByteRejected(bytes32 seed, uint8 lenRaw, uint8 pos, bytes1 raw)
        public
        view
    {
        bytes memory b = bytes(LabelGen.valid(seed, lenRaw));
        uint256 at = bound(pos, 0, b.length - 1);
        b[at] = LabelGen.badByte(raw);
        assertFalse(lib.isValid(string(b)));
    }

    function testFuzz_hyphenAtEdgeRejected(bytes32 seed, uint8 lenRaw, bool leading) public view {
        bytes memory b = bytes(LabelGen.valid(seed, lenRaw));
        b[leading ? 0 : b.length - 1] = "-";
        assertFalse(lib.isValid(string(b)));
    }

    function testFuzz_punycodeSlotRejected(bytes32 seed, uint8 lenRaw) public view {
        bytes memory b = bytes(LabelGen.valid(seed, bound(lenRaw, 5, 63)));
        b[2] = "-";
        b[3] = "-";
        assertFalse(lib.isValid(string(b)));
    }

    function testFuzz_tooLongRejected(bytes32 seed, uint8 extra) public view {
        uint256 len = 64 + uint256(extra);
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = LabelGen.ALPHABET[uint8(keccak256(abi.encodePacked(seed, i))[0]) % 36];
        }
        assertFalse(lib.isValid(string(b)));
    }

    /// @dev Arbitrary bytes agree with the independent reference checker.
    function testFuzz_matchesReference(bytes memory raw) public view {
        assertEq(lib.isValid(string(raw)), LabelGen.isValidReference(raw));
    }

    /// @dev Short arbitrary strings drawn from the alphabet (plus a few outsiders) agree with
    ///      the reference; this hits the hyphen and position rules far more often than raw bytes.
    function testFuzz_alphabetStringsMatchReference(bytes32 seed, uint8 lenRaw) public view {
        uint256 len = bound(lenRaw, 0, 70);
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint8 r = uint8(keccak256(abi.encodePacked(seed, i))[0]);
            // Mostly alphabet, hyphen-heavy, with an occasional outsider.
            if (r % 16 == 0) b[i] = bytes1(uint8(0x40 + (r >> 4)));
            else if (r % 4 == 0) b[i] = "-";
            else b[i] = LabelGen.ALPHABET[r % 36];
        }
        assertEq(lib.isValid(string(b)), LabelGen.isValidReference(b));
    }
}
