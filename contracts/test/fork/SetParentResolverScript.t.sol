// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deploy} from "../../script/Deploy.s.sol";
import {SetParentResolver} from "../../script/SetParentResolver.s.sol";
import {IEnsV2Registry, IUniversalResolver} from "../../src/interfaces/external/ens/IEnsV2.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Mainnet-fork rehearsal of the operator's ENS step: deploy with the real script, run
///         `SetParentResolver` as the real owner of `varada.eth`, then resolve the parent through
///         the ENS Universal Resolver. Skipped when ETH_RPC_URL is unset.
contract SetParentResolverScriptForkTest is Test, Deploy {
    IEnsV2Registry internal constant ETH_REGISTRY =
        IEnsV2Registry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IUniversalResolver internal constant UNIVERSAL_RESOLVER =
        IUniversalResolver(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    /// @dev `addr(bytes32)`.
    bytes4 internal constant ADDR_SELECTOR = 0x3b3b57de;

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    Deployment internal d;
    SetParentResolver internal script;
    address internal nameOwner;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vm.startBroadcast(deployer);
        d = deploy(
            Config({owner: owner, platformTreasury: treasury, siteSwarmRef: bytes32(0)}), deployer
        );
        vm.stopBroadcast();

        script = new SetParentResolver();
        nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(script.labelId()));
        assertTrue(nameOwner != address(0), "varada.eth is registered");
    }

    function test_fork_run_pointsNameAtResolverAsRealOwner() public {
        assertTrue(ETH_REGISTRY.getResolver("varada") != d.resolver, "fresh fork");
        vm.setEnv("RESOLVER", vm.toString(d.resolver));
        script.run(); // ENS_OWNER defaults to the live owner
        assertEq(ETH_REGISTRY.getResolver("varada"), d.resolver);
        // Idempotent: a second run sends nothing and does not revert.
        script.run();
        assertEq(ETH_REGISTRY.getResolver("varada"), d.resolver);

        // The parent now answers through the Verada resolver: its addr is the platform treasury.
        bytes32 node = DnsNameLib.namehash(PARENT_DNS_NAME, 0);
        (bytes memory result, address answering) = UNIVERSAL_RESOLVER.resolve(
            DnsNameLib.encode(PARENT_NAME), abi.encodeWithSelector(ADDR_SELECTOR, node)
        );
        assertEq(answering, d.resolver, "UR used the Verada resolver");
        assertEq(abi.decode(result, (address)), treasury, "varada.eth -> treasury");
    }

    function test_fork_refusesASignerWhoIsNotTheOwner() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(SetParentResolver.NotOwner.selector, nameOwner, stranger)
        );
        script.execute(d.resolver, stranger);
    }

    function test_fork_refusesContractsThatAreNotTheResolver() public {
        // Not `makeAddr`: those well-known keys get EIP-7702 delegations on mainnet (23 bytes of
        // code), so pick an address nobody holds and confirm it is empty.
        address nobody = address(uint160(uint256(keccak256(abi.encode(block.number, "no-code")))));
        assertEq(nobody.code.length, 0, "precondition: no code");
        vm.expectRevert(abi.encodeWithSelector(SetParentResolver.NoCode.selector, nobody));
        script.execute(nobody, nameOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                SetParentResolver.NotExtendedResolver.selector, address(ETH_REGISTRY)
            )
        );
        script.execute(address(ETH_REGISTRY), nameOwner);
    }
}
