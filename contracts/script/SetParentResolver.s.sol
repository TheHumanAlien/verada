// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VeradaResolver} from "../src/VeradaResolver.sol";
import {IEnsV2Registry} from "../src/interfaces/external/ens/IEnsV2.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title SetParentResolver
/// @notice The one ENS transaction after deployment: the owner of `varada.eth` on ENSv2 points the
///         name at the Verada resolver, so `varada.eth`, every `<label>.varada.eth` and the agent
///         names resolve through it. Idempotent: sends nothing when the resolver is already set.
/// @dev Environment for `run()`:
///        RESOLVER    the deployed `VeradaResolver` (default: `resolver` in
///                    `deployments/<chainid>.json`, written by `Deploy`)
///        ENS_OWNER   the account that signs (default: the registry's current owner of the name)
///      Before sending, the script checks that the resolver has code, serves ENSIP-10 and was
///      built for `varada.eth`, and that the name is registered, unexpired and owned by the signer.
///      Simulate:   forge script script/SetParentResolver.s.sol --rpc-url $ETH_RPC_URL
///      Send:       forge script script/SetParentResolver.s.sol --rpc-url $ETH_RPC_URL --broadcast \
///                      --ledger            (or --account <keystore>, or --private-key ...)
///      The raw calldata is also printed for signing from a wallet UI.
contract SetParentResolver is Script {
    /// @dev ENSv2 `.eth` registry on Ethereum mainnet (docs.ens.domains/learn/deployments).
    IEnsV2Registry internal constant ETH_REGISTRY =
        IEnsV2Registry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    string internal constant PARENT_LABEL = "varada";
    /// @dev DNS wire-format encoding of `varada.eth`.
    bytes internal constant PARENT_DNS_NAME = hex"067661726164610365746800";
    /// @dev ENSIP-10 `resolve(bytes,bytes)`.
    bytes4 internal constant ENSIP10_INTERFACE = 0x9061b923;

    error NotMainnet(uint256 chainId);
    error NoCode(address resolver);
    error NotExtendedResolver(address resolver);
    error WrongParent(bytes32 expected, bytes32 actual);
    error NotRegistered();
    error Expired(uint64 expiry);
    error NotOwner(address nameOwner, address signer);
    error NotSet(address expected, address actual);

    function run() external {
        address resolver = vm.envOr("RESOLVER", address(0));
        if (resolver == address(0)) {
            string memory json =
                vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
            resolver = vm.parseJsonAddress(json, ".resolver");
        }
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(labelId()));
        address signer = vm.envOr("ENS_OWNER", nameOwner);
        execute(resolver, signer);
    }

    /// @notice `uint256(keccak256("varada"))`: the registry id of the name.
    function labelId() public pure returns (uint256) {
        return uint256(keccak256(bytes(PARENT_LABEL)));
    }

    /// @notice Checks everything, prints the calldata and, unless already set, broadcasts
    ///         `setResolver` from `signer`.
    function execute(address resolver, address signer) public {
        uint256 id = labelId();
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(id));
        check(resolver, id, nameOwner, signer);

        console.log("ETHRegistry        ", address(ETH_REGISTRY));
        console.log("varada labelId     ", id);
        console.log("VeradaResolver     ", resolver);
        console.log("setResolver calldata:");
        console.logBytes(abi.encodeCall(IEnsV2Registry.setResolver, (id, resolver)));

        address current = ETH_REGISTRY.getResolver(PARENT_LABEL);
        if (current == resolver) {
            console.log("varada.eth already resolves through this resolver; nothing to send");
            return;
        }
        console.log("current resolver   ", current);

        vm.startBroadcast(signer);
        ETH_REGISTRY.setResolver(id, resolver);
        vm.stopBroadcast();

        address now_ = ETH_REGISTRY.getResolver(PARENT_LABEL);
        if (now_ != resolver) revert NotSet(resolver, now_);
        console.log("done: varada.eth and every subname now resolve through", resolver);
    }

    /// @notice Reverts unless the transaction is the right one to send.
    function check(address resolver, uint256 id, address nameOwner, address signer) public view {
        if (block.chainid != 1) revert NotMainnet(block.chainid);
        if (resolver.code.length == 0) revert NoCode(resolver);
        try VeradaResolver(resolver).supportsInterface(ENSIP10_INTERFACE) returns (bool ok) {
            if (!ok) revert NotExtendedResolver(resolver);
        } catch {
            revert NotExtendedResolver(resolver);
        }
        bytes32 expected = DnsNameLib.namehash(PARENT_DNS_NAME, 0);
        try VeradaResolver(resolver).parentNode() returns (bytes32 actual) {
            if (actual != expected) revert WrongParent(expected, actual);
        } catch {
            revert WrongParent(expected, bytes32(0));
        }
        if (nameOwner == address(0)) revert NotRegistered();
        uint64 expiry = ETH_REGISTRY.getExpiry(id);
        if (expiry <= block.timestamp) revert Expired(expiry);
        if (signer != nameOwner) revert NotOwner(nameOwner, signer);
    }
}
