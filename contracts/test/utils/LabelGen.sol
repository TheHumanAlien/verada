// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Deterministic label generator for fuzz tests: builds labels from the `[a-z0-9-]`
///      alphabet that satisfy every `LabelLib` rule, and an independent validity checker.
library LabelGen {
    bytes internal constant ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

    /// @notice A valid label of `len` bytes (clamped to 3..63) derived from `seed`.
    function valid(bytes32 seed, uint256 len) internal pure returns (string memory) {
        if (len < 3) len = 3;
        if (len > 63) len = 63;
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = ALPHABET[uint8(keccak256(abi.encodePacked(seed, i))[0]) % ALPHABET.length];
        }
        if (b[0] == "-") b[0] = "a";
        if (b[len - 1] == "-") b[len - 1] = "z";
        if (len >= 4 && b[2] == "-" && b[3] == "-") b[3] = "b";
        return string(b);
    }

    /// @notice Whether `c` is in the label alphabet.
    function inAlphabet(bytes1 c) internal pure returns (bool) {
        for (uint256 i; i < ALPHABET.length; ++i) {
            if (ALPHABET[i] == c) return true;
        }
        return false;
    }

    /// @notice Any byte outside the alphabet, derived from `raw`.
    function badByte(bytes1 raw) internal pure returns (bytes1) {
        return inAlphabet(raw) ? bytes1(uint8(raw) | 0x80) : raw;
    }

    /// @notice Independent re-statement of the label rules, written without `LabelLib`.
    function isValidReference(bytes memory b) internal pure returns (bool) {
        uint256 n = b.length;
        if (n < 3) return false;
        if (n > 63) return false;
        for (uint256 i; i < n; ++i) {
            if (!inAlphabet(b[i])) return false;
        }
        if (b[0] == "-") return false;
        if (b[n - 1] == "-") return false;
        if (n > 3 && b[2] == "-" && b[3] == "-") return false;
        return true;
    }
}
