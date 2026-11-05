// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {VeradaResolver} from "../src/VeradaResolver.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "../src/interfaces/ICuratorRegistry.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IERC8004IdentityRegistry} from "../src/interfaces/external/IERC8004IdentityRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {ContenthashLib} from "../src/libraries/ContenthashLib.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {IdentityRegistryMock} from "./mocks/IdentityRegistryMock.sol";
import {CatalogFixture} from "./utils/CatalogFixture.sol";

/// @notice `<label>.agent.varada.eth` and `agent.varada.eth` through the resolver.
contract VeradaResolverAgentsTest is Test {
    bytes internal constant PARENT_DNS = hex"0676617261646103657468" hex"00";
    bytes32 internal constant PARENT_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;

    TokenProfileRegistry internal profiles;
    CuratorRegistry internal curators;
    VeradaResolver internal resolver;
    IdentityRegistryMock internal identity;
    address internal vault;
    uint256 internal agentId;
    bytes internal siteHash = ContenthashLib.swarm(keccak256("site"));

    function setUp() public {
        profiles = new TokenProfileRegistry(address(this), makeAddr("factory"), PARENT_NODE);
        profiles.setDefaultContenthash(siteHash);
        identity = new IdentityRegistryMock();
        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        CatalogFixture cat = new CatalogFixture();
        cat.add(32, bytes32("org"));
        cat.publish();
        curators = new CuratorRegistry(
            address(this),
            IERC8004IdentityRegistry(address(identity)),
            ICauseCatalog(address(cat.catalog())),
            ICauseRegistry(
                address(
                    new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(orgFactory)))
                )
            ),
            IEndaomentOrgFundFactory(address(orgFactory)),
            IERC20(address(usdc)),
            ITokenProfileRegistry(address(profiles))
        );
        // Someone else's agent first, so ours gets id 1.
        vm.prank(makeAddr("someone"));
        identity.register("", new IERC8004IdentityRegistry.MetadataEntry[](0));
        (agentId, vault) =
            curators.registerAgent(1, "homeless", makeAddr("signer"), "", "Homelessness curator");
        resolver = new VeradaResolver(
            profiles, PARENT_DNS, ICuratorRegistry(address(curators)), "varada.eth"
        );
    }

    function _resolve(string memory dotted, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        return resolver.resolve(DnsNameLib.encode(dotted), data);
    }

    function _text(string memory dotted, string memory key) internal view returns (string memory) {
        bytes32 node = DnsNameLib.namehash(DnsNameLib.encode(dotted), 0);
        return
            abi.decode(_resolve(dotted, abi.encodeCall(ITextResolver.text, (node, key))), (string));
    }

    function test_agentName_resolvesItsVaultAndRecords() public view {
        string memory name = "homeless.agent.varada.eth";
        bytes32 node = DnsNameLib.namehash(DnsNameLib.encode(name), 0);
        address a = abi.decode(
            _resolve(name, abi.encodeWithSelector(IAddrResolver.addr.selector, node)), (address)
        );
        assertEq(a, vault);
        bytes memory coin = abi.decode(
            _resolve(
                name, abi.encodeWithSelector(IAddressResolver.addr.selector, node, uint256(60))
            ),
            (bytes)
        );
        assertEq(coin, abi.encodePacked(vault));
        bytes memory ch = abi.decode(
            _resolve(name, abi.encodeCall(IContentHashResolver.contenthash, (node))), (bytes)
        );
        assertEq(ch, siteHash, "the dApp serves the agent page");
        assertEq(_text(name, "url"), "https://homeless.agent.varada.eth.limo");
        assertEq(_text(name, "description"), "Homelessness curator");
        assertEq(_text(name, "verada.category"), "1");
        assertEq(
            _text(name, "agent-registration"),
            string.concat("eip155:31337:", vm.toLowercase(vm.toString(address(identity))), ":1")
        );
        assertEq(_text(name, "com.twitter"), "");
        assertEq(agentId, 1);
    }

    function test_legacyNodeCalls_answerAgents() public view {
        bytes32 node = DnsNameLib.namehash(DnsNameLib.encode("homeless.agent.varada.eth"), 0);
        assertEq(resolver.addr(node), vault);
        assertEq(resolver.text(node, "description"), "Homelessness curator");
        assertEq(resolver.contenthash(node), siteHash);
        bytes32 index = DnsNameLib.namehash(DnsNameLib.encode("agent.varada.eth"), 0);
        assertEq(index, curators.agentsNode());
        assertEq(resolver.addr(index), address(curators));
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(ITextResolver.text, (node, "url"));
        assertEq(
            abi.decode(resolver.multicall(calls)[0], (string)),
            "https://homeless.agent.varada.eth.limo"
        );
    }

    function test_agentsIndex_andUnknownAgents() public view {
        bytes32 node = DnsNameLib.namehash(DnsNameLib.encode("agent.varada.eth"), 0);
        address a = abi.decode(
            _resolve("agent.varada.eth", abi.encodeWithSelector(IAddrResolver.addr.selector, node)),
            (address)
        );
        assertEq(a, address(curators));
        assertEq(_text("agent.varada.eth", "url"), "https://agent.varada.eth.limo");
        // An unregistered agent label belongs to the agents namespace and answers zero values.
        bytes32 other = DnsNameLib.namehash(DnsNameLib.encode("hunger.agent.varada.eth"), 0);
        a = abi.decode(
            _resolve(
                "hunger.agent.varada.eth",
                abi.encodeWithSelector(IAddrResolver.addr.selector, other)
            ),
            (address)
        );
        assertEq(a, address(0));
        assertEq(_text("hunger.agent.varada.eth", "description"), "");
    }

    function test_withoutCurators_agentNamesAreNotSpecial() public {
        VeradaResolver plain =
            new VeradaResolver(profiles, PARENT_DNS, ICuratorRegistry(address(0)), "varada.eth");
        bytes32 node = DnsNameLib.namehash(DnsNameLib.encode("homeless.agent.varada.eth"), 0);
        bytes memory r = plain.resolve(
            DnsNameLib.encode("homeless.agent.varada.eth"),
            abi.encodeWithSelector(IAddrResolver.addr.selector, node)
        );
        assertEq(abi.decode(r, (address)), address(0));
        assertTrue(plain.supportsInterface(type(IExtendedResolver).interfaceId));
    }
}
