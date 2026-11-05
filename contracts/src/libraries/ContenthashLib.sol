// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ContenthashLib
/// @notice EIP-1577 contenthash encoding for Swarm references.
/// @dev `bzz://<ref>` is `0xe4` (swarm namespace) ‖ `0x01` (CIDv1) ‖ `0xfa01` (swarm-manifest
///      multicodec, varint) ‖ `0x1b` (keccak-256 multihash) ‖ `0x20` (32 bytes) ‖ reference.
library ContenthashLib {
    /// @notice Prefix of every Swarm manifest contenthash.
    bytes7 internal constant SWARM_PREFIX = hex"e40101fa011b20";
    /// @notice Length of a Swarm contenthash (prefix plus 32-byte reference).
    uint256 internal constant SWARM_LENGTH = 39;

    /// @notice Builds the contenthash for a 32-byte Swarm reference.
    function swarm(bytes32 ref) internal pure returns (bytes memory) {
        return abi.encodePacked(SWARM_PREFIX, ref);
    }

    /// @notice Whether `hash` is a Swarm manifest contenthash.
    function isSwarm(bytes memory hash) internal pure returns (bool) {
        return hash.length == SWARM_LENGTH && bytes7(hash) == SWARM_PREFIX;
    }
}
