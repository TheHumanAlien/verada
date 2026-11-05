// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IERC8004IdentityRegistry} from "../../src/interfaces/external/IERC8004IdentityRegistry.sol";

/// @dev Minimal stand-in for the ERC-8004 `IdentityRegistryUpgradeable` with the behaviour Verada
///      relies on: `register` mints like `_safeMint` (calls `onERC721Received` on contracts),
///      owner/approved checks, the reserved `agentWallet` key, and `setAgentWallet` verifying an
///      EIP-712 `AgentWalletSet(agentId,newWallet,owner,deadline)` signature in the domain
///      `ERC8004IdentityRegistry`/`1` by ECDSA or else ERC-1271, with a 5-minute deadline window.
contract IdentityRegistryMock is IERC8004IdentityRegistry {
    bytes32 internal constant AGENT_WALLET_SET_TYPEHASH = keccak256(
        "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    uint256 public lastId;
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => string) internal _uris;
    mapping(uint256 => mapping(string => bytes)) internal _metadata;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function walletDigest(uint256 agentId, address newWallet, address owner, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function register(string memory agentURI, MetadataEntry[] memory metadata)
        external
        returns (uint256 agentId)
    {
        agentId = lastId++;
        _owners[agentId] = msg.sender;
        _uris[agentId] = agentURI;
        _metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        for (uint256 i; i < metadata.length; ++i) {
            require(
                keccak256(bytes(metadata[i].metadataKey)) != keccak256("agentWallet"),
                "reserved key"
            );
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
        }
        if (msg.sender.code.length != 0) {
            require(
                IERC721Receiver(msg.sender).onERC721Received(msg.sender, address(0), agentId, "")
                    == IERC721Receiver.onERC721Received.selector,
                "not a receiver"
            );
        }
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(msg.sender == _owners[agentId], "Not authorized");
        _uris[agentId] = newURI;
    }

    function setMetadata(uint256 agentId, string memory key, bytes memory value) external {
        require(msg.sender == _owners[agentId], "Not authorized");
        require(keccak256(bytes(key)) != keccak256("agentWallet"), "reserved key");
        _metadata[agentId][key] = value;
    }

    function getMetadata(uint256 agentId, string memory key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        address owner = _owners[agentId];
        require(msg.sender == owner, "Not authorized");
        require(newWallet != address(0), "bad wallet");
        require(block.timestamp <= deadline, "expired");
        require(deadline <= block.timestamp + 5 minutes, "deadline too far");
        bytes32 digest = walletDigest(agentId, newWallet, owner, deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != newWallet) {
            (bool ok, bytes memory res) =
                newWallet.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature));
            require(
                ok && res.length >= 32 && abi.decode(res, (bytes4)) == 0x1626ba7e,
                "invalid wallet sig"
            );
        }
        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return address(bytes20(_metadata[agentId]["agentWallet"]));
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        return _uris[agentId];
    }
}
