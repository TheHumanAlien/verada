// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Test} from "forge-std/Test.sol";

import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {VeradaResolver} from "../src/VeradaResolver.sol";
import {ICuratorRegistry} from "../src/interfaces/ICuratorRegistry.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {ContenthashLib} from "../src/libraries/ContenthashLib.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {LabelGen} from "./utils/LabelGen.sol";

contract VeradaResolverTest is Test {
    // \x06varada\x03eth\x00
    bytes internal constant PARENT_DNS = hex"0676617261646103657468" hex"00";
    // namehash("varada.eth"), namehash("pepe.varada.eth")
    bytes32 internal constant PARENT_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;
    bytes32 internal constant PEPE_NODE =
        0x1d5d7832f3d8c36e3cd2f591b85b37bb1cfdc47fa841737d9e1632e10689c782;
    bytes32 internal constant LOGO = bytes32(uint256(0xdeadbeef));
    uint256 internal constant COIN_TYPE_BASE = 0x80002105;

    TokenProfileRegistry internal registry;
    VeradaResolver internal resolver;

    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal platform = makeAddr("platform");
    address internal token = makeAddr("pepe-token");

    bytes internal siteHash = ContenthashLib.swarm(keccak256("site"));
    bytes internal pepeHash = ContenthashLib.swarm(keccak256("pepe-site"));

    function setUp() public {
        registry = new TokenProfileRegistry(address(this), factory, PARENT_NODE);
        resolver =
            new VeradaResolver(registry, PARENT_DNS, ICuratorRegistry(address(0)), "varada.eth");
        registry.setPlatformAddress(platform);
        registry.setDefaultContenthash(siteHash);
        registry.setParentText("url", "https://varada.eth.limo");
        registry.setParentText("description", "Verada");
        vm.prank(factory);
        registry.register(token, "pepe", creator, LOGO);
        vm.prank(creator);
        registry.setText(token, "url", "https://pepe.example");
    }

    // ------------------------------------------------------------------ helpers

    function _name(string memory dotted) internal pure returns (bytes memory) {
        return DnsNameLib.encode(dotted);
    }

    function _addrCall(bytes32 node) internal pure returns (bytes memory) {
        return abi.encodeCall(IAddrResolver.addr, (node));
    }

    function _coinCall(bytes32 node, uint256 coinType) internal pure returns (bytes memory) {
        return abi.encodeCall(IAddressResolver.addr, (node, coinType));
    }

    function _textCall(bytes32 node, string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(ITextResolver.text, (node, key));
    }

    function _hashCall(bytes32 node) internal pure returns (bytes memory) {
        return abi.encodeCall(IContentHashResolver.contenthash, (node));
    }

    function _multicall(bytes[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(VeradaResolver.multicall, (calls));
    }

    function _rAddr(bytes memory name, bytes32 node) internal view returns (address) {
        bytes memory res = resolver.resolve(name, _addrCall(node));
        assertEq(res.length, 32, "addr is one word");
        return abi.decode(res, (address));
    }

    function _rCoin(bytes memory name, bytes32 node, uint256 coinType)
        internal
        view
        returns (bytes memory)
    {
        bytes memory res = resolver.resolve(name, _coinCall(node, coinType));
        assertGe(res.length, 64, "encoded bytes");
        return abi.decode(res, (bytes));
    }

    function _rText(bytes memory name, bytes32 node, string memory key)
        internal
        view
        returns (string memory)
    {
        bytes memory res = resolver.resolve(name, _textCall(node, key));
        assertGe(res.length, 64, "encoded string");
        return abi.decode(res, (string));
    }

    function _rHash(bytes memory name, bytes32 node) internal view returns (bytes memory) {
        bytes memory res = resolver.resolve(name, _hashCall(node));
        assertGe(res.length, 64, "encoded bytes");
        return abi.decode(res, (bytes));
    }

    function _node(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertEq(address(resolver.registry()), address(registry));
        assertEq(resolver.parentNode(), PARENT_NODE);
        assertEq(resolver.parentNode(), DnsNameLib.namehash(PARENT_DNS, 0));
        assertEq(resolver.COIN_TYPE_ETH(), 60);
        assertEq(resolver.LOGO_TEXT_KEY(), "verada.logo");
    }

    function test_constructor_parentNodeMismatch() public {
        bytes memory otherName = _name("other.eth");
        bytes32 otherNode = DnsNameLib.namehash(otherName, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                VeradaResolver.ParentNodeMismatch.selector, PARENT_NODE, otherNode
            )
        );
        new VeradaResolver(registry, otherName, ICuratorRegistry(address(0)), "varada.eth");

        // A child of the parent is not the parent either.
        bytes memory childName = _name("pepe.varada.eth");
        vm.expectRevert(
            abi.encodeWithSelector(
                VeradaResolver.ParentNodeMismatch.selector, PARENT_NODE, PEPE_NODE
            )
        );
        new VeradaResolver(registry, childName, ICuratorRegistry(address(0)), "varada.eth");
    }

    function test_constructor_malformedParentName() public {
        bytes memory bad = hex"0676617261646103657468"; // no terminator
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.InvalidDnsName.selector, bad));
        new VeradaResolver(registry, bad, ICuratorRegistry(address(0)), "varada.eth");
    }

    // ------------------------------------------------------------------ parent

    function test_parent_addr() public view {
        bytes memory name = PARENT_DNS;
        assertEq(_rAddr(name, PARENT_NODE), platform);
        assertEq(_rCoin(name, PARENT_NODE, 60), abi.encodePacked(platform));
        assertEq(_rCoin(name, PARENT_NODE, 0), "", "btc");
        assertEq(_rCoin(name, PARENT_NODE, COIN_TYPE_BASE), "", "evm chain coin type");
    }

    function test_parent_text() public view {
        assertEq(_rText(PARENT_DNS, PARENT_NODE, "url"), "https://varada.eth.limo");
        assertEq(_rText(PARENT_DNS, PARENT_NODE, "description"), "Verada");
        assertEq(_rText(PARENT_DNS, PARENT_NODE, "com.twitter"), "");
        assertEq(_rText(PARENT_DNS, PARENT_NODE, "verada.logo"), "", "no synthesized logo");
    }

    function test_parent_contenthash() public {
        assertEq(_rHash(PARENT_DNS, PARENT_NODE), siteHash);
        registry.setDefaultContenthash("");
        assertEq(_rHash(PARENT_DNS, PARENT_NODE), "");
    }

    function test_parent_platformUnset() public {
        registry.setPlatformAddress(address(0));
        assertEq(_rAddr(PARENT_DNS, PARENT_NODE), address(0));
        assertEq(_rCoin(PARENT_DNS, PARENT_NODE, 60), "");
    }

    // ------------------------------------------------------------------ child

    function test_child_addr() public view {
        bytes memory name = _name("pepe.varada.eth");
        assertEq(_rAddr(name, PEPE_NODE), token);
        assertEq(_rCoin(name, PEPE_NODE, 60), abi.encodePacked(token));
        assertEq(_rCoin(name, PEPE_NODE, 60).length, 20);
        assertEq(_rCoin(name, PEPE_NODE, 0), "");
        assertEq(_rCoin(name, PEPE_NODE, COIN_TYPE_BASE), "");
    }

    function test_child_text() public {
        bytes memory name = _name("pepe.varada.eth");
        assertEq(_rText(name, PEPE_NODE, "url"), "https://pepe.example");
        assertEq(_rText(name, PEPE_NODE, "description"), "", "parent text does not leak");
        vm.prank(creator);
        registry.setText(token, "description", "the frog");
        assertEq(_rText(name, PEPE_NODE, "description"), "the frog");
    }

    function test_child_logoText() public {
        bytes memory name = _name("pepe.varada.eth");
        assertEq(
            _rText(name, PEPE_NODE, "verada.logo"),
            "0x00000000000000000000000000000000000000000000000000000000deadbeef"
        );
        vm.prank(creator);
        registry.setLogoRef(token, bytes32(type(uint256).max));
        assertEq(
            _rText(name, PEPE_NODE, "verada.logo"),
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        );

        // Without a logo reference the stored text record (if any) answers.
        vm.prank(creator);
        registry.setLogoRef(token, bytes32(0));
        assertEq(_rText(name, PEPE_NODE, "verada.logo"), "");
        vm.prank(creator);
        registry.setText(token, "verada.logo", "ipfs://legacy");
        assertEq(_rText(name, PEPE_NODE, "verada.logo"), "ipfs://legacy");

        // A logo reference wins over the stored text.
        vm.prank(creator);
        registry.setLogoRef(token, LOGO);
        assertEq(
            _rText(name, PEPE_NODE, "verada.logo"),
            "0x00000000000000000000000000000000000000000000000000000000deadbeef"
        );
    }

    function test_child_contenthash() public {
        bytes memory name = _name("pepe.varada.eth");
        assertEq(_rHash(name, PEPE_NODE), siteHash, "default");
        vm.prank(creator);
        registry.setContenthash(token, pepeHash);
        assertEq(_rHash(name, PEPE_NODE), pepeHash, "override");
        vm.prank(creator);
        registry.setContenthash(token, "");
        assertEq(_rHash(name, PEPE_NODE), siteHash, "cleared");
        registry.setDefaultContenthash("");
        assertEq(_rHash(name, PEPE_NODE), "", "no default");
    }

    function test_child_registeredLater() public {
        bytes memory name = _name("doge.varada.eth");
        assertEq(_rAddr(name, _node("doge")), address(0));
        address doge = makeAddr("doge-token");
        vm.prank(factory);
        registry.register(doge, "doge", creator, 0);
        assertEq(_rAddr(name, _node("doge")), doge);
        assertEq(_rText(name, _node("doge"), "verada.logo"), "", "no logo");
    }

    // ------------------------------------------------------------------ unknown

    function _assertUnknown(bytes memory name, bytes32 node) internal view {
        assertEq(_rAddr(name, node), address(0), "addr");
        assertEq(_rCoin(name, node, 60), "", "addr(60)");
        assertEq(_rCoin(name, node, 0), "", "addr(0)");
        assertEq(_rText(name, node, "url"), "", "text");
        assertEq(_rText(name, node, "verada.logo"), "", "logo");
        assertEq(_rHash(name, node), "", "contenthash");
    }

    function test_unknownLabel() public view {
        _assertUnknown(_name("doge.varada.eth"), _node("doge"));
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(_name("doge.varada.eth"));
        assertFalse(isParent);
        assertEq(labelhash, keccak256("doge"));
        assertEq(t, address(0));
    }

    function test_suppressedLabel() public {
        bytes memory name = _name("pepe.varada.eth");
        registry.setSuppressed(token, true);
        _assertUnknown(name, PEPE_NODE);
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256("pepe"));
        assertEq(t, address(0));
        // Legacy entry points too.
        assertEq(resolver.addr(PEPE_NODE), address(0));
        assertEq(resolver.text(PEPE_NODE, "url"), "");
        assertEq(resolver.contenthash(PEPE_NODE), "");

        registry.setSuppressed(token, false);
        assertEq(_rAddr(name, PEPE_NODE), token);
        assertEq(resolver.addr(PEPE_NODE), token);
    }

    function test_deeperNameIsUnknown() public view {
        bytes memory name = _name("sub.pepe.varada.eth");
        _assertUnknown(name, DnsNameLib.namehash(name, 0));
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256("sub"));
        assertEq(t, address(0));
    }

    function test_otherParentIsUnknown() public view {
        bytes memory name = _name("pepe.other.eth");
        _assertUnknown(name, DnsNameLib.namehash(name, 0));
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256("pepe"));
        assertEq(t, address(0));
        // The bare parent label at the top level is not the parent either.
        _assertUnknown(_name("varada.eth.xyz"), DnsNameLib.namehash(_name("varada.eth.xyz"), 0));
        _assertUnknown(_name("verada"), DnsNameLib.namehash(_name("verada"), 0));
        _assertUnknown(_name("eth"), DnsNameLib.namehash(_name("eth"), 0));
    }

    function test_uppercaseLabelDoesNotMatch() public view {
        bytes memory name = _name("PEPE.varada.eth");
        assertEq(_rAddr(name, PEPE_NODE), address(0));
        (, bytes32 labelhash, address t) = resolver.parseName(name);
        assertEq(labelhash, keccak256("PEPE"));
        assertEq(t, address(0));
        // The parent must match byte for byte as well.
        bytes memory upperParent = _name("pepe.VERADA.eth");
        assertEq(_rAddr(upperParent, PEPE_NODE), address(0));
    }

    function test_parseName_parent() public view {
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(PARENT_DNS);
        assertTrue(isParent);
        assertEq(labelhash, bytes32(0));
        assertEq(t, address(0));
    }

    // ------------------------------------------------------------------ malformed names

    function _assertInvalid(bytes memory name) internal {
        vm.expectRevert(abi.encodeWithSelector(VeradaResolver.InvalidDnsName.selector, name));
        resolver.resolve(name, _addrCall(bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(VeradaResolver.InvalidDnsName.selector, name));
        resolver.parseName(name);
    }

    function test_malformed_empty() public {
        _assertInvalid("");
    }

    function test_malformed_rootOnly() public {
        _assertInvalid(hex"00");
    }

    function test_malformed_zeroLengthFirstLabel() public {
        _assertInvalid(abi.encodePacked(bytes1(0), PARENT_DNS));
    }

    function test_malformed_labelTooLong() public {
        bytes memory label = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            label[i] = "a";
        }
        _assertInvalid(abi.encodePacked(bytes1(uint8(64)), label, PARENT_DNS));
        _assertInvalid(abi.encodePacked(bytes1(uint8(255)), label, PARENT_DNS));
    }

    function test_malformed_noRoomForSuffix() public {
        _assertInvalid(hex"0470657065"); // \x04pepe and nothing after it
        _assertInvalid(hex"05706570"); // claims 5 bytes, has 3
        _assertInvalid(hex"01"); // claims 1 byte, has none
    }

    function test_63ByteLabelIsWellFormed() public {
        bytes memory label = new bytes(63);
        for (uint256 i; i < 63; ++i) {
            label[i] = "a";
        }
        bytes memory name = abi.encodePacked(bytes1(uint8(63)), label, PARENT_DNS);
        (bool isParent, bytes32 labelhash, address t) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256(label));
        assertEq(t, address(0));
        address longToken = makeAddr("long");
        vm.prank(factory);
        registry.register(longToken, string(label), creator, 0);
        assertEq(_rAddr(name, _node(string(label))), longToken);
    }

    // ------------------------------------------------------------------ unsupported profiles

    function test_unsupportedSelectorReverts() public {
        bytes memory name = _name("pepe.varada.eth");
        bytes4 nameSel = bytes4(keccak256("name(bytes32)"));
        vm.expectRevert(
            abi.encodeWithSelector(VeradaResolver.UnsupportedResolverProfile.selector, nameSel)
        );
        resolver.resolve(name, abi.encodeWithSelector(nameSel, PEPE_NODE));

        bytes4 abiSel = bytes4(keccak256("ABI(bytes32,uint256)"));
        vm.expectRevert(
            abi.encodeWithSelector(VeradaResolver.UnsupportedResolverProfile.selector, abiSel)
        );
        resolver.resolve(PARENT_DNS, abi.encodeWithSelector(abiSel, PARENT_NODE, uint256(1)));

        // Short data is reported with the zero-padded selector.
        bytes4 padded = 0x01000000;
        vm.expectRevert(
            abi.encodeWithSelector(VeradaResolver.UnsupportedResolverProfile.selector, padded)
        );
        resolver.resolve(name, hex"01");
        vm.expectRevert(
            abi.encodeWithSelector(VeradaResolver.UnsupportedResolverProfile.selector, bytes4(0))
        );
        resolver.resolve(name, "");
    }

    function test_unsupportedSelectorRevertsForUnknownToo() public {
        bytes4 sel = 0x12345678;
        vm.expectRevert(
            abi.encodeWithSelector(VeradaResolver.UnsupportedResolverProfile.selector, sel)
        );
        resolver.resolve(_name("doge.varada.eth"), abi.encodeWithSelector(sel, bytes32(0)));
    }

    // ------------------------------------------------------------------ multicall

    function test_multicall_viaResolve() public {
        bytes memory name = _name("pepe.varada.eth");
        vm.prank(creator);
        registry.setContenthash(token, pepeHash);

        bytes[] memory calls = new bytes[](7);
        calls[0] = _addrCall(PEPE_NODE);
        calls[1] = _textCall(PEPE_NODE, "url");
        calls[2] = _hashCall(PEPE_NODE);
        calls[3] = abi.encodeWithSelector(bytes4(keccak256("name(bytes32)")), PEPE_NODE);
        calls[4] = _coinCall(PEPE_NODE, 60);
        calls[5] = _textCall(PEPE_NODE, "verada.logo");
        calls[6] = _multicall(new bytes[](0)); // nested batches are not answered

        bytes memory res = resolver.resolve(name, _multicall(calls));
        bytes[] memory out = abi.decode(res, (bytes[]));
        assertEq(out.length, 7);
        assertEq(abi.decode(out[0], (address)), token);
        assertEq(abi.decode(out[1], (string)), "https://pepe.example");
        assertEq(abi.decode(out[2], (bytes)), pepeHash);
        assertEq(out[3].length, 0, "unsupported item is empty");
        assertEq(abi.decode(out[4], (bytes)), abi.encodePacked(token));
        assertEq(
            abi.decode(out[5], (string)),
            "0x00000000000000000000000000000000000000000000000000000000deadbeef"
        );
        assertEq(out[6].length, 0, "nested multicall is empty");
    }

    function test_multicall_viaResolve_parentAndUnknown() public view {
        bytes[] memory calls = new bytes[](3);
        calls[0] = _addrCall(PARENT_NODE);
        calls[1] = _textCall(PARENT_NODE, "url");
        calls[2] = _hashCall(PARENT_NODE);
        bytes[] memory out = abi.decode(resolver.resolve(PARENT_DNS, _multicall(calls)), (bytes[]));
        assertEq(abi.decode(out[0], (address)), platform);
        assertEq(abi.decode(out[1], (string)), "https://varada.eth.limo");
        assertEq(abi.decode(out[2], (bytes)), siteHash);

        // The name decides, not the nodes inside the items.
        out = abi.decode(resolver.resolve(_name("doge.varada.eth"), _multicall(calls)), (bytes[]));
        assertEq(abi.decode(out[0], (address)), address(0));
        assertEq(abi.decode(out[1], (string)), "");
        assertEq(abi.decode(out[2], (bytes)), "");
    }

    function test_multicall_viaResolve_empty() public view {
        bytes memory res = resolver.resolve(PARENT_DNS, _multicall(new bytes[](0)));
        assertGt(res.length, 0, "never raw empty bytes");
        bytes[] memory out = abi.decode(res, (bytes[]));
        assertEq(out.length, 0);
    }

    function test_multicall_direct() public {
        vm.prank(creator);
        registry.setContenthash(token, pepeHash);
        bytes32 dogeNode = _node("doge");

        bytes[] memory calls = new bytes[](8);
        calls[0] = _addrCall(PEPE_NODE);
        calls[1] = _addrCall(PARENT_NODE);
        calls[2] = _textCall(PARENT_NODE, "url");
        calls[3] = _hashCall(dogeNode);
        calls[4] = abi.encodeWithSelector(bytes4(keccak256("name(bytes32)")), PEPE_NODE);
        calls[5] = _coinCall(PEPE_NODE, 60);
        calls[6] = hex"3b3b57de"; // addr selector without a node
        calls[7] = _multicall(calls);

        bytes[] memory out = resolver.multicall(calls);
        assertEq(out.length, 8);
        assertEq(abi.decode(out[0], (address)), token);
        assertEq(abi.decode(out[1], (address)), platform);
        assertEq(abi.decode(out[2], (string)), "https://varada.eth.limo");
        assertEq(abi.decode(out[3], (bytes)), "");
        assertEq(out[4].length, 0, "unsupported");
        assertEq(abi.decode(out[5], (bytes)), abi.encodePacked(token));
        assertEq(out[6].length, 0, "too short");
        assertEq(out[7].length, 0, "nested");
    }

    // ------------------------------------------------------------------ legacy direct calls

    function test_legacy_addr() public view {
        assertEq(resolver.addr(PEPE_NODE), token);
        assertEq(resolver.addr(PARENT_NODE), platform);
        assertEq(resolver.addr(_node("doge")), address(0));
        assertEq(resolver.addr(bytes32(0)), address(0));
    }

    function test_legacy_addrCoin() public view {
        assertEq(resolver.addr(PEPE_NODE, 60), abi.encodePacked(token));
        assertEq(resolver.addr(PARENT_NODE, 60), abi.encodePacked(platform));
        assertEq(resolver.addr(PEPE_NODE, 0), "");
        assertEq(resolver.addr(PEPE_NODE, COIN_TYPE_BASE), "");
        assertEq(resolver.addr(_node("doge"), 60), "");
    }

    function test_legacy_text() public view {
        assertEq(resolver.text(PEPE_NODE, "url"), "https://pepe.example");
        assertEq(
            resolver.text(PEPE_NODE, "verada.logo"),
            "0x00000000000000000000000000000000000000000000000000000000deadbeef"
        );
        assertEq(resolver.text(PARENT_NODE, "url"), "https://varada.eth.limo");
        assertEq(resolver.text(_node("doge"), "url"), "");
    }

    function test_legacy_contenthash() public {
        assertEq(resolver.contenthash(PEPE_NODE), siteHash);
        assertEq(resolver.contenthash(PARENT_NODE), siteHash);
        assertEq(resolver.contenthash(_node("doge")), "");
        vm.prank(creator);
        registry.setContenthash(token, pepeHash);
        assertEq(resolver.contenthash(PEPE_NODE), pepeHash);
        assertEq(resolver.contenthash(PARENT_NODE), siteHash);
    }

    // ------------------------------------------------------------------ ERC-165

    function test_supportsInterface() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7), "IERC165");
        assertTrue(resolver.supportsInterface(0x9061b923), "IExtendedResolver");
        assertTrue(resolver.supportsInterface(0x3b3b57de), "IAddrResolver");
        assertTrue(resolver.supportsInterface(0xf1cb7e06), "IAddressResolver");
        assertTrue(resolver.supportsInterface(0x59d1d43c), "ITextResolver");
        assertTrue(resolver.supportsInterface(0xbc1c58d1), "IContentHashResolver");
        assertTrue(resolver.supportsInterface(0xac9650d8), "multicall");

        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
        assertEq(type(IExtendedResolver).interfaceId, bytes4(0x9061b923));
        assertEq(type(IAddrResolver).interfaceId, bytes4(0x3b3b57de));
        assertEq(type(IAddressResolver).interfaceId, bytes4(0xf1cb7e06));
        assertEq(type(ITextResolver).interfaceId, bytes4(0x59d1d43c));
        assertEq(type(IContentHashResolver).interfaceId, bytes4(0xbc1c58d1));
        assertEq(VeradaResolver.multicall.selector, bytes4(0xac9650d8));

        assertFalse(resolver.supportsInterface(0xffffffff), "ERC-165 sentinel");
        assertFalse(resolver.supportsInterface(0x00000000));
        assertFalse(resolver.supportsInterface(0x691f3431), "name(bytes32)");
        assertFalse(resolver.supportsInterface(0x2203ab56), "ABI");
        assertFalse(resolver.supportsInterface(0xc8690233), "pubkey");
        assertFalse(resolver.supportsInterface(VeradaResolver.parseName.selector), "parseName");
    }

    function testFuzz_supportsInterfaceNeverReverts(bytes4 id) public view {
        resolver.supportsInterface(id);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_validLabelRoundTrip(bytes32 seed, uint8 len, address t) public {
        vm.assume(t != address(0) && t != token);
        string memory label = LabelGen.valid(seed, len);
        vm.assume(keccak256(bytes(label)) != keccak256("pepe"));
        vm.prank(factory);
        bytes32 node = registry.register(t, label, creator, 0);

        bytes memory name = _name(string.concat(label, ".varada.eth"));
        assertEq(DnsNameLib.namehash(name, 0), node);
        (bool isParent, bytes32 labelhash, address found) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256(bytes(label)));
        assertEq(found, t);
        assertEq(_rAddr(name, node), t);
        assertEq(resolver.addr(node), t);
        assertEq(_rCoin(name, node, 60), abi.encodePacked(t));
        assertEq(_rHash(name, node), siteHash);
    }

    function testFuzz_unregisteredLabelIsUnknown(bytes32 seed, uint8 len) public view {
        string memory label = LabelGen.valid(seed, len);
        vm.assume(keccak256(bytes(label)) != keccak256("pepe"));
        bytes memory name = _name(string.concat(label, ".varada.eth"));
        (bool isParent, bytes32 labelhash, address found) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256(bytes(label)));
        assertEq(found, address(0));
        _assertUnknown(name, _node(label));
    }

    function testFuzz_randomSuffixIsUnknown(bytes memory suffix) public view {
        vm.assume(suffix.length > 0 && keccak256(suffix) != keccak256(PARENT_DNS));
        bytes memory name = abi.encodePacked(bytes1(uint8(4)), "pepe", suffix);
        (bool isParent, bytes32 labelhash, address found) = resolver.parseName(name);
        assertFalse(isParent);
        assertEq(labelhash, keccak256("pepe"));
        assertEq(found, address(0));
        assertEq(_rAddr(name, PEPE_NODE), address(0));
    }

    function testFuzz_textPassthrough(string memory key, string memory value) public {
        vm.assume(keccak256(bytes(key)) != keccak256("verada.logo"));
        vm.prank(creator);
        registry.setText(token, key, value);
        bytes memory name = _name("pepe.varada.eth");
        assertEq(_rText(name, PEPE_NODE, key), value);
        assertEq(resolver.text(PEPE_NODE, key), value);
        registry.setParentText(key, value);
        assertEq(_rText(PARENT_DNS, PARENT_NODE, key), value);
    }

    function testFuzz_logoHexMatchesReference(bytes32 logoRef) public {
        vm.assume(logoRef != bytes32(0));
        vm.prank(creator);
        registry.setLogoRef(token, logoRef);
        assertEq(resolver.text(PEPE_NODE, "verada.logo"), vm.toString(logoRef));
    }

    function testFuzz_otherCoinTypesEmpty(uint256 coinType) public view {
        vm.assume(coinType != 60);
        assertEq(resolver.addr(PEPE_NODE, coinType), "");
        assertEq(resolver.addr(PARENT_NODE, coinType), "");
        assertEq(_rCoin(_name("pepe.varada.eth"), PEPE_NODE, coinType), "");
    }

    /// @dev Whatever the name, `resolve` with a supported profile never returns raw empty bytes.
    function testFuzz_resolveNeverReturnsRawEmpty(bytes memory raw) public view {
        try resolver.resolve(raw, _addrCall(bytes32(0))) returns (bytes memory res) {
            assertEq(res.length, 32);
        } catch (bytes memory err) {
            assertEq(_selector(err), VeradaResolver.InvalidDnsName.selector);
        }
        try resolver.resolve(raw, _hashCall(bytes32(0))) returns (bytes memory res) {
            assertGe(res.length, 64);
        } catch (bytes memory err) {
            assertEq(_selector(err), VeradaResolver.InvalidDnsName.selector);
        }
    }

    function _selector(bytes memory err) internal pure returns (bytes4) {
        // only the selector is wanted
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(err);
    }
}
