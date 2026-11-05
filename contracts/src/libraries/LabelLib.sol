// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title LabelLib
/// @notice Validation for the ENS label a token is registered under (`<label>.varada.eth`).
/// @dev Accepted labels are a strict subset of ENSIP-15 normalized names: 3 to 63 bytes of
///      `[a-z0-9-]`, no leading or trailing hyphen and no hyphens at both positions 3 and 4
///      (the `xn--` punycode slot). Because only lowercase ASCII is accepted, a client that
///      normalizes `PEPE.varada.eth` to `pepe.varada.eth` always lands on the stored label, and
///      the DNS wire format (63-byte labels) is never exceeded.
library LabelLib {
    /// @notice Shortest accepted label.
    uint256 internal constant MIN_LENGTH = 3;
    /// @notice Longest accepted label (DNS wire-format limit).
    uint256 internal constant MAX_LENGTH = 63;

    error InvalidLabel(string label);

    /// @notice Reverts unless `label` is valid; returns its labelhash (`keccak256(label)`).
    function validate(string memory label) internal pure returns (bytes32) {
        if (!isValid(label)) revert InvalidLabel(label);
        return keccak256(bytes(label));
    }

    /// @notice Whether `label` satisfies every rule.
    function isValid(string memory label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 len = b.length;
        if (len < MIN_LENGTH || len > MAX_LENGTH) return false;
        if (b[0] == "-" || b[len - 1] == "-") return false;
        if (len >= 4 && b[2] == "-" && b[3] == "-") return false;
        for (uint256 i; i < len; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) return false;
        }
        return true;
    }
}
