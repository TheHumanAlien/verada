// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {TokenProfileRegistry} from "../../src/TokenProfileRegistry.sol";
import {VeradaFactory} from "../../src/VeradaFactory.sol";
import {VeradaResolver} from "../../src/VeradaResolver.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaFactory} from "../../src/interfaces/IVeradaFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    ITextResolver
} from "../../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {IEnsV2Registry, IUniversalResolver} from "../../src/interfaces/external/ens/IEnsV2.sol";
import {ContenthashLib} from "../../src/libraries/ContenthashLib.sol";
import {DnsNameLib} from "../../src/libraries/DnsNameLib.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";

/// @notice Mainnet-fork test of ENS resolution end to end: deploy with the real script, point
///         `varada.eth` (registered on ENSv2 by its real owner) at the Verada resolver, launch a
///         token and resolve `<label>.varada.eth` through the ENS Universal Resolver.
///         Skipped when ETH_RPC_URL is unset.
contract EnsResolutionForkTest is Test, Deploy {
    /// @dev ENSv2 `.eth` registry and Universal Resolver proxy (docs.ens.domains/learn/deployments).
    IEnsV2Registry internal constant ETH_REGISTRY =
        IEnsV2Registry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IUniversalResolver internal constant UNIVERSAL_RESOLVER =
        IUniversalResolver(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    uint256 internal constant PARENT_LABEL_ID = uint256(keccak256("varada"));
    bytes32 internal constant SITE_REF =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 internal constant OVERRIDE_REF =
        0x3333333333333333333333333333333333333333333333333333333333333333;

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    Deployment internal d;
    address internal tokenAddr;
    bytes32 internal tokenNode;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vm.startBroadcast(deployer);
        d = deploy(
            Config({owner: owner, platformTreasury: treasury, siteSwarmRef: SITE_REF}), deployer
        );
        vm.stopBroadcast();

        vm.startPrank(owner);
        TokenProfileRegistry(d.profileRegistry).acceptOwnership();
        QuoteRegistry(d.quoteRegistry).acceptOwnership();
        // A launch needs a published catalogue with at least two orgs in its focus.
        CauseCatalog(d.causeCatalog).acceptOwnership();
        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = bytes32("200049703");
        orgs[1] = bytes32("873024488");
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);
        PoolKey memory ethKey =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethKey;
        QuoteRegistry(d.quoteRegistry)
            .addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        vm.stopPrank();

        // The real owner of varada.eth points the name at the Verada resolver (the one manual
        // step after deployment). On a fork we impersonate them.
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(PARENT_LABEL_ID));
        assertTrue(nameOwner != address(0), "varada.eth is registered");
        assertGt(ETH_REGISTRY.getExpiry(PARENT_LABEL_ID), block.timestamp, "varada.eth not expired");
        vm.prank(nameOwner);
        ETH_REGISTRY.setResolver(PARENT_LABEL_ID, d.resolver);
        assertEq(ETH_REGISTRY.getResolver("varada"), d.resolver);

        // Launch `pepe`.
        IVeradaFactory.DeployParams memory p = IVeradaFactory.DeployParams({
            name: "Pepe",
            symbol: "PEPE",
            metadataURI: "bzz://4444444444444444444444444444444444444444444444444444444444444444",
            salt: bytes32(uint256(7)),
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: WETH,
            label: "pepe",
            logoRef: bytes32(uint256(0xabc)),
            categoryMask: CatalogPublish.CATEGORIES,
            regionMask: CatalogPublish.REGIONS
        });
        vm.prank(creator);
        (tokenAddr,) = VeradaFactory(d.factory).deployToken(p);
        tokenNode = TokenProfileRegistry(d.profileRegistry).nodeOf(tokenAddr);
    }

    // ------------------------------------------------------------------ helpers

    function _resolve(string memory name, bytes memory call)
        internal
        view
        returns (bytes memory result, address resolver)
    {
        return UNIVERSAL_RESOLVER.resolve(DnsNameLib.encode(name), call);
    }

    function _addr(string memory name) internal view returns (address) {
        (bytes memory res, address resolver) =
            _resolve(name, abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
        assertEq(resolver, d.resolver, "answered by the Verada resolver");
        return abi.decode(res, (address));
    }

    function _text(string memory name, string memory key) internal view returns (string memory) {
        (bytes memory res,) = _resolve(name, abi.encodeCall(ITextResolver.text, (bytes32(0), key)));
        return abi.decode(res, (string));
    }

    function _contenthash(string memory name) internal view returns (bytes memory) {
        (bytes memory res,) =
            _resolve(name, abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0))));
        return abi.decode(res, (bytes));
    }

    // ------------------------------------------------------------------ tests

    function test_subnameResolvesToToken() public view {
        assertEq(_addr("pepe.varada.eth"), tokenAddr);
        assertEq(_addr("PEPE.varada.eth"), address(0), "labels are case sensitive on-chain");

        (bytes memory res,) = _resolve(
            "pepe.varada.eth", abi.encodeCall(IAddressResolver.addr, (bytes32(0), uint256(60)))
        );
        assertEq(abi.decode(res, (bytes)), abi.encodePacked(tokenAddr));
    }

    function test_subnameContenthashDefaultsToSiteAndCanBeOverridden() public {
        assertEq(_contenthash("pepe.varada.eth"), ContenthashLib.swarm(SITE_REF));
        assertEq(_contenthash("varada.eth"), ContenthashLib.swarm(SITE_REF));

        vm.prank(creator);
        TokenProfileRegistry(d.profileRegistry)
            .setContenthash(tokenAddr, ContenthashLib.swarm(OVERRIDE_REF));
        assertEq(_contenthash("pepe.varada.eth"), ContenthashLib.swarm(OVERRIDE_REF));
        assertEq(_contenthash("varada.eth"), ContenthashLib.swarm(SITE_REF), "parent unchanged");
    }

    function test_textRecordsAndLogo() public {
        assertEq(_text("pepe.varada.eth", "url"), "");
        vm.prank(creator);
        TokenProfileRegistry(d.profileRegistry).setText(tokenAddr, "url", "https://pepe.example");
        assertEq(_text("pepe.varada.eth", "url"), "https://pepe.example");
        assertEq(
            _text("pepe.varada.eth", "verada.logo"),
            "0x0000000000000000000000000000000000000000000000000000000000000abc"
        );
    }

    function test_parentAndUnknownNames() public view {
        assertEq(_addr("varada.eth"), treasury);
        assertEq(_addr("nope.varada.eth"), address(0));
        assertEq(_addr("sub.pepe.varada.eth"), address(0));
        assertEq(_contenthash("nope.varada.eth"), "");
    }

    function test_directResolverCallsByNode() public view {
        VeradaResolver resolver = VeradaResolver(d.resolver);
        assertEq(resolver.addr(tokenNode), tokenAddr);
        assertEq(resolver.contenthash(tokenNode), ContenthashLib.swarm(SITE_REF));
        assertEq(resolver.addr(resolver.parentNode()), treasury);
    }
}
