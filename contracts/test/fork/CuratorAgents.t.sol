// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {AgentVault} from "../../src/AgentVault.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";
import {TokenProfileRegistry} from "../../src/TokenProfileRegistry.sol";
import {ICuratorRegistry} from "../../src/interfaces/ICuratorRegistry.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/external/IERC8004IdentityRegistry.sol";
import {
    IAddrResolver,
    ITextResolver
} from "../../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {IEnsV2Registry, IUniversalResolver} from "../../src/interfaces/external/ens/IEnsV2.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {CatalogPublish, CatalogTree} from "../utils/CatalogFixture.sol";

/// @notice Mainnet fork: a curator agent registered on the live ERC-8004 Identity Registry, its
///         vault linked as the agent wallet (ERC-1271), `hunger.agent.varada.eth` resolved through
///         the ENS Universal Resolver, and a vault gift to a live Endaoment org.
///         Skipped when ETH_RPC_URL is unset.
contract CuratorAgentsForkTest is Test, Deploy {
    IEnsV2Registry internal constant ETH_REGISTRY =
        IEnsV2Registry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IUniversalResolver internal constant UNIVERSAL_RESOLVER =
        IUniversalResolver(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    uint256 internal constant PARENT_LABEL_ID = uint256(keccak256("varada"));
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant FRESH_ORG = bytes32("873024488");

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    uint256 internal signerKey = 0x5157;
    address internal signer = vm.addr(0x5157);

    Deployment internal d;
    CuratorRegistry internal curators;
    IERC8004IdentityRegistry internal identity = IERC8004IdentityRegistry(ERC8004_IDENTITY);
    bytes32[] internal orgs;
    bytes32[] internal leaves;
    uint256 internal agentId;
    address internal vault;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertGt(ERC8004_IDENTITY.code.length, 0, "ERC-8004 Identity Registry deployed");

        vm.startBroadcast(deployer);
        d = deploy(
            Config({
                owner: owner, platformTreasury: makeAddr("treasury"), siteSwarmRef: bytes32(0)
            }),
            deployer
        );
        vm.stopBroadcast();
        curators = CuratorRegistry(d.curatorRegistry);

        vm.startPrank(owner);
        curators.acceptOwnership();
        CauseCatalog(d.causeCatalog).acceptOwnership();
        TokenProfileRegistry(d.profileRegistry).acceptOwnership();
        orgs.push(WIKI_ORG); // hunger x Africa entry 0 (bucket 32)
        orgs.push(FRESH_ORG); // entry 1
        leaves = CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);
        (agentId, vault) = curators.registerAgent(
            2, "hunger", signer, "data:application/json;base64,e30=", "Hunger and famine curator"
        );
        vm.stopPrank();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                ERC8004_IDENTITY
            )
        );
    }

    function test_fork_identityIsOwnedByTheRegistry_andVaultLinksAsAgentWallet() public {
        assertEq(identity.ownerOf(agentId), address(curators));
        assertEq(identity.tokenURI(agentId), "data:application/json;base64,e30=");
        assertEq(identity.getMetadata(agentId, "verada.vault"), abi.encodePacked(vault));

        uint256 deadline = block.timestamp + 120;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"
                ),
                agentId,
                vault,
                address(curators),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        vm.prank(owner);
        curators.linkAgentWallet(2, deadline, abi.encodePacked(r, s, v));
        assertEq(
            identity.getAgentWallet(agentId),
            vault,
            "live registry accepted the vault's ERC-1271 check"
        );
    }

    function test_fork_agentNameResolvesThroughTheUniversalResolver() public {
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(PARENT_LABEL_ID));
        vm.prank(nameOwner);
        ETH_REGISTRY.setResolver(PARENT_LABEL_ID, d.resolver);

        (bytes memory res, address resolver) = UNIVERSAL_RESOLVER.resolve(
            DnsNameLib.encode("hunger.agent.varada.eth"),
            abi.encodeCall(IAddrResolver.addr, (bytes32(0)))
        );
        assertEq(resolver, d.resolver);
        assertEq(abi.decode(res, (address)), vault);
        (res,) = UNIVERSAL_RESOLVER.resolve(
            DnsNameLib.encode("hunger.agent.varada.eth"),
            abi.encodeCall(ITextResolver.text, (bytes32(0), "url"))
        );
        assertEq(abi.decode(res, (string)), "https://hunger.agent.varada.eth.limo");
        // No token can take the agents label.
        (bool reserved,) = _reservation();
        assertTrue(reserved);
    }

    function _reservation() internal view returns (bool reserved, address allowed) {
        ITokenProfileRegistry.Reservation memory r =
            TokenProfileRegistry(d.profileRegistry).reservationOf(keccak256("agent"));
        return (r.reserved, r.allowedCreator);
    }

    function test_fork_vaultGivesToALiveEndaomentOrg() public {
        address donor = makeAddr("donor");
        deal(USDC, donor, 1000e6);
        vm.startPrank(donor);
        IERC20(USDC).approve(vault, 1000e6);
        AgentVault(vault).donate(500e6, true);
        vm.stopPrank();
        vm.prank(owner);
        AgentVault(vault).setMaxGivePerEpoch(200e6);

        uint256 before = IERC20(USDC).balanceOf(WIKI_ADDR);
        vm.prank(signer);
        address org = AgentVault(vault).give(0, WIKI_ORG, 0, CatalogTree.proof(leaves, 0), 100e6);
        assertEq(org, WIKI_ADDR);
        assertGt(
            IERC20(USDC).balanceOf(WIKI_ADDR),
            before,
            "the org received the gift (net of Endaoment's fee)"
        );
        assertEq(IERC20(USDC).balanceOf(vault), 400e6);

        // A fresh org is deployed by the gift.
        vm.prank(signer);
        address fresh = AgentVault(vault).give(0, FRESH_ORG, 1, CatalogTree.proof(leaves, 1), 50e6);
        assertGt(fresh.code.length, 0);
    }

    function test_fork_submitCurations() public {
        ICuratorRegistry.CurationInput[] memory c = new ICuratorRegistry.CurationInput[](1);
        c[0] = ICuratorRegistry.CurationInput(0, keccak256("root"), 2, 10_000);
        uint256 next = curators.currentEpoch() + 1;
        vm.prank(signer);
        uint256 g = gasleft();
        curators.submitCurations(2, next, 1, keccak256("report"), c);
        emit log_named_uint("submitCurations gas, one region", g - gasleft());
        assertEq(curators.curationOf(32, next).count, 2);
    }
}
