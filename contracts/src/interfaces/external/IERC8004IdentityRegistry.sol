// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IERC8004IdentityRegistry
/// @notice The parts of the ERC-8004 (Trustless Agents, Draft) Identity Registry Verada uses, as
///         deployed on Ethereum mainnet at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (an
///         upgradeable proxy of `IdentityRegistryUpgradeable`, ERC-721 "AgentIdentity").
/// @dev `register` mints with `_safeMint`, so a contract owner must accept ERC-721 transfers.
///      `setAgentWallet` checks an EIP-712 signature over
///      `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)` in the
///      domain `ERC8004IdentityRegistry`/`1`, by ECDSA or else ERC-1271 on `newWallet`; the deadline
///      may be at most 5 minutes ahead. The wallet is cleared when the token is transferred.
interface IERC8004IdentityRegistry {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    function register(string memory agentURI, MetadataEntry[] memory metadata)
        external
        returns (uint256 agentId);

    function setAgentURI(uint256 agentId, string calldata newURI) external;

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue)
        external;

    function getMetadata(uint256 agentId, string memory metadataKey)
        external
        view
        returns (bytes memory);

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external;

    function getAgentWallet(uint256 agentId) external view returns (address);

    function ownerOf(uint256 agentId) external view returns (address);

    function tokenURI(uint256 agentId) external view returns (string memory);
}
