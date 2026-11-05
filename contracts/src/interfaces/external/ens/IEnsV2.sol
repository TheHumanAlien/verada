// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev The slice of an ENSv2 permissioned registry (the `.eth` registry on mainnet is one)
///      that Verada needs. `anyId` is the label id, `uint256(keccak256(bytes(label)))`.
interface IEnsV2Registry {
    /// @notice Points `anyId` at `resolver`. Caller needs the set-resolver role for the name.
    function setResolver(uint256 anyId, address resolver) external;

    /// @notice Resolver registered for `label`, or zero.
    function getResolver(string calldata label) external view returns (address);

    /// @notice Current (mutable) ERC-1155 token id of the name.
    function getTokenId(uint256 anyId) external view returns (uint256);

    /// @notice Owner of a token id.
    function ownerOf(uint256 tokenId) external view returns (address);

    /// @notice Expiry timestamp of the name (zero if never registered).
    function getExpiry(uint256 anyId) external view returns (uint64);
}

/// @dev ENS Universal Resolver (V2) read entry point.
interface IUniversalResolver {
    /// @param name DNS-encoded name.
    /// @param data ABI-encoded resolver profile call.
    /// @return result ABI-encoded profile return value.
    /// @return resolver The resolver that answered.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result, address resolver);
}
