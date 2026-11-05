// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DnsNameLib
/// @notice Helpers for DNS wire-format names as used by ENSIP-10 (`resolve(bytes name, ...)`):
///         a sequence of `<length byte><label bytes>` ending with a zero length byte.
library DnsNameLib {
    error InvalidDnsName(bytes name);

    /// @notice Reads the label starting at `offset`.
    /// @return labelhash `keccak256` of the label, or zero for the terminating empty label.
    /// @return next Offset of the following label.
    function readLabel(bytes memory name, uint256 offset)
        internal
        pure
        returns (bytes32 labelhash, uint256 next)
    {
        if (offset >= name.length) revert InvalidDnsName(name);
        uint256 len = uint8(name[offset]);
        next = offset + 1 + len;
        if (len == 0) return (bytes32(0), next);
        if (next > name.length) revert InvalidDnsName(name);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            labelhash := keccak256(add(add(name, 0x20), add(offset, 1)), len)
        }
    }

    /// @notice ENS namehash of the name starting at `offset`.
    /// @dev Reverts on a missing terminator or on bytes after it.
    function namehash(bytes memory name, uint256 offset) internal pure returns (bytes32) {
        (bytes32 labelhash, uint256 next) = readLabel(name, offset);
        if (labelhash == bytes32(0)) {
            if (next != name.length) revert InvalidDnsName(name);
            return bytes32(0);
        }
        return keccak256(abi.encodePacked(namehash(name, next), labelhash));
    }

    /// @notice Encodes a dotted name (`pepe.varada.eth`) in DNS wire format.
    /// @dev Labels must be 1 to 63 bytes; an empty string encodes the root (`0x00`).
    function encode(string memory dotted) internal pure returns (bytes memory out) {
        bytes memory src = bytes(dotted);
        if (src.length == 0) return hex"00";
        out = new bytes(src.length + 2);
        uint256 labelStart;
        uint256 w;
        for (uint256 i; i <= src.length; ++i) {
            if (i == src.length || src[i] == ".") {
                uint256 len = i - labelStart;
                if (len == 0 || len > 63) revert InvalidDnsName(src);
                out[w++] = bytes1(uint8(len));
                for (uint256 j = labelStart; j < i; ++j) {
                    out[w++] = src[j];
                }
                labelStart = i + 1;
            }
        }
        out[w] = 0;
    }
}
