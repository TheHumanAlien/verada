// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev ENSIP-10 wildcard resolution. Interface id 0x9061b923.
interface IExtendedResolver {
    /// @param name DNS-encoded, normalized name being resolved.
    /// @param data ABI-encoded call of a legacy resolver profile (addr/text/contenthash...).
    /// @return ABI-encoded return value of that profile.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @dev Interface id 0x3b3b57de.
interface IAddrResolver {
    function addr(bytes32 node) external view returns (address payable);
}

/// @dev ENSIP-9 multichain addresses. Interface id 0xf1cb7e06. Coin type 60 is Ether.
interface IAddressResolver {
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

/// @dev ENSIP-5 text records. Interface id 0x59d1d43c.
interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @dev ENSIP-7 contenthash. Interface id 0xbc1c58d1.
interface IContentHashResolver {
    function contenthash(bytes32 node) external view returns (bytes memory);
}
