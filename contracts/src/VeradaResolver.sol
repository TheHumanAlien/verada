// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "./interfaces/external/ens/IEnsResolverProfiles.sol";
import {DnsNameLib} from "./libraries/DnsNameLib.sol";

interface ICuratorIdentity {
    function identityRegistry() external view returns (address);
}

/// @title VeradaResolver
/// @notice Stateless ENSIP-10 wildcard resolver for the Verada parent name and every
///         `<label>.<parent>` registered in the `TokenProfileRegistry`. The parent resolves to the
///         platform address and the default site contenthash; a child resolves to its token
///         address, its text records (with `verada.logo` synthesized from the logo reference) and
///         its contenthash override or the default. Unknown and suppressed labels resolve to
///         zero values rather than reverting, so clients see "no record" instead of an error.
///         Curator agents resolve as `<label>.agent.<parent>` (the agent's vault, its description,
///         gateway URL and ERC-8004 registration) and `agent.<parent>` is the agents index.
/// @dev Set as the resolver of the parent name once; registering a token needs no ENS write.
///      Every answer from `resolve` is ABI-encoded (never raw empty bytes). Legacy direct entry
///      points (`addr`, `text`, ...) look the node up in the registry for callers that bypass
///      the Universal Resolver. Ownerless: all configuration lives in the registry.
contract VeradaResolver is
    IExtendedResolver,
    IAddrResolver,
    IAddressResolver,
    ITextResolver,
    IContentHashResolver,
    IERC165
{
    /// @notice ENSIP-9 coin type of Ether.
    uint256 public constant COIN_TYPE_ETH = 60;
    /// @notice Text record key answered from the registry's logo reference.
    string public constant LOGO_TEXT_KEY = "verada.logo";

    ITokenProfileRegistry public immutable registry;
    /// @notice Curator registry for `<label>.agent.<parent>` (zero: no agent names).
    ICuratorRegistry public immutable curators;
    /// @notice CAIP-10 style prefix of the agents' ERC-8004 registry, e.g. `eip155:1:0x8004…:`.
    string internal _agentRegistryPrefix;
    /// @notice Dotted parent name (`varada.eth`), for gateway URLs.
    string internal _parentName;

    bytes32 internal immutable _agentsDnsHash;
    uint256 internal immutable _agentsDnsLength;

    uint8 internal constant TARGET_NONE = 0;
    uint8 internal constant TARGET_AGENTS_INDEX = 1;
    uint8 internal constant TARGET_AGENT = 2;
    /// @notice Namehash of the parent name (`varada.eth`).
    bytes32 public immutable parentNode;

    bytes32 internal immutable _parentDnsHash;
    uint256 internal immutable _parentDnsLength;

    /// @dev Exact name and signature the ENS Universal Resolver passes through to clients.
    error UnsupportedResolverProfile(bytes4 selector);
    error InvalidDnsName(bytes name);
    error ParentNodeMismatch(bytes32 expected, bytes32 actual);

    /// @param registry_ Profile registry holding the labels.
    /// @param parentDnsName DNS wire-format parent name, `\x06varada\x03eth\x00` for varada.eth.
    /// @param curators_ Curator registry (zero to serve tokens only).
    /// @param parentName Dotted parent name (`varada.eth`).
    constructor(
        ITokenProfileRegistry registry_,
        bytes memory parentDnsName,
        ICuratorRegistry curators_,
        string memory parentName
    ) {
        registry = registry_;
        curators = curators_;
        _parentName = parentName;
        bytes memory agentsDns = bytes.concat(hex"05", "agent", parentDnsName);
        _agentsDnsHash = keccak256(agentsDns);
        _agentsDnsLength = agentsDns.length;
        if (address(curators_) != address(0)) {
            _agentRegistryPrefix = string.concat(
                "eip155:", _decimal(block.chainid), ":", _addressHex(_identityOf(curators_)), ":"
            );
        }
        bytes32 node = DnsNameLib.namehash(parentDnsName, 0);
        bytes32 expected = registry_.parentNode();
        if (node != expected) revert ParentNodeMismatch(expected, node);
        parentNode = node;
        _parentDnsHash = keccak256(parentDnsName);
        _parentDnsLength = parentDnsName.length;
    }

    // ------------------------------------------------------------------ ENSIP-10

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        (uint8 kind, uint8 categoryBit) = _agentTarget(name);
        if (kind != TARGET_NONE) return _answerAgent(kind, categoryBit, data);
        (bool isParent,, address token) = _parse(name);
        return _answer(isParent, token, data);
    }

    /// @notice Splits a DNS-encoded name into the parent flag, first labelhash and token.
    /// @dev Test and UI helper. Reverts on malformed names; a name under another parent, an
    ///      unknown label and a suppressed token all yield `token == address(0)`.
    function parseName(bytes calldata name)
        external
        view
        returns (bool isParent, bytes32 labelhash, address token)
    {
        return _parse(name);
    }

    // ------------------------------------------------------------------ legacy profiles

    /// @inheritdoc IAddrResolver
    function addr(bytes32 node) external view returns (address payable) {
        (uint8 kind, uint8 categoryBit) = _agentTargetOfNode(node);
        if (kind != TARGET_NONE) return payable(_agentAddress(kind, categoryBit));
        (bool isParent, address token) = _lookup(node);
        return payable(_ethAddress(isParent, token));
    }

    /// @inheritdoc IAddressResolver
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        (uint8 kind, uint8 categoryBit) = _agentTargetOfNode(node);
        if (kind != TARGET_NONE) return _agentCoinAddress(kind, categoryBit, coinType);
        (bool isParent, address token) = _lookup(node);
        return _coinAddress(isParent, token, coinType);
    }

    /// @inheritdoc ITextResolver
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        (uint8 kind, uint8 categoryBit) = _agentTargetOfNode(node);
        if (kind != TARGET_NONE) return _agentText(kind, categoryBit, key);
        (bool isParent, address token) = _lookup(node);
        return _text(isParent, token, key);
    }

    /// @inheritdoc IContentHashResolver
    function contenthash(bytes32 node) external view returns (bytes memory) {
        (uint8 kind,) = _agentTargetOfNode(node);
        if (kind != TARGET_NONE) return registry.defaultContenthash();
        (bool isParent, address token) = _lookup(node);
        return _contenthash(isParent, token);
    }

    /// @notice Answers several legacy profile calls; each item names its own node.
    /// @dev An item with an unsupported selector (nested multicalls included) yields empty bytes.
    function multicall(bytes[] calldata data) external view returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            bytes calldata item = data[i];
            if (item.length < 36 || _selector(item) == this.multicall.selector) continue;
            bytes32 node = abi.decode(item[4:36], (bytes32));
            (uint8 kind, uint8 categoryBit) = _agentTargetOfNode(node);
            if (kind != TARGET_NONE) {
                results[i] = _tryAnswerAgent(kind, categoryBit, item);
                continue;
            }
            (bool isParent, address token) = _lookup(node);
            results[i] = _tryAnswer(isParent, token, item);
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IExtendedResolver).interfaceId
            || interfaceId == type(IAddrResolver).interfaceId
            || interfaceId == type(IAddressResolver).interfaceId
            || interfaceId == type(ITextResolver).interfaceId
            || interfaceId == type(IContentHashResolver).interfaceId
            || interfaceId == this.multicall.selector;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Parent when the whole name is the parent; otherwise the first label must be 1 to 63
    ///      bytes and leave room for a suffix. A suffix other than the parent (a deeper name or
    ///      another parent the Universal Resolver routed here) is unknown, not malformed.
    function _parse(bytes calldata name)
        internal
        view
        returns (bool isParent, bytes32 labelhash, address token)
    {
        if (name.length == _parentDnsLength && keccak256(name) == _parentDnsHash) {
            return (true, bytes32(0), address(0));
        }
        if (name.length == 0) revert InvalidDnsName(name);
        uint256 len = uint8(name[0]);
        if (len == 0 || len > 63 || 1 + len >= name.length) revert InvalidDnsName(name);
        labelhash = keccak256(name[1:1 + len]);
        bytes calldata suffix = name[1 + len:];
        if (suffix.length != _parentDnsLength || keccak256(suffix) != _parentDnsHash) {
            return (false, labelhash, address(0));
        }
        token = _visible(registry.tokenByLabelhash(labelhash));
    }

    function _lookup(bytes32 node) internal view returns (bool isParent, address token) {
        if (node == parentNode) return (true, address(0));
        token = _visible(registry.tokenByNode(node));
    }

    /// @dev Suppressed tokens resolve like unknown labels.
    function _visible(address token) internal view returns (address) {
        if (token != address(0) && registry.isSuppressed(token)) return address(0);
        return token;
    }

    /// @dev Dispatches one profile call; reverts on an unsupported selector.
    function _answer(bool isParent, address token, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = _selector(data);
        if (selector == IAddrResolver.addr.selector) {
            return abi.encode(_ethAddress(isParent, token));
        }
        if (selector == IAddressResolver.addr.selector) {
            (, uint256 coinType) = abi.decode(_args(data), (bytes32, uint256));
            return abi.encode(_coinAddress(isParent, token, coinType));
        }
        if (selector == ITextResolver.text.selector) {
            (, string memory key) = abi.decode(_args(data), (bytes32, string));
            return abi.encode(_text(isParent, token, key));
        }
        if (selector == IContentHashResolver.contenthash.selector) {
            return abi.encode(_contenthash(isParent, token));
        }
        if (selector == this.multicall.selector) {
            bytes[] memory calls = abi.decode(_args(data), (bytes[]));
            bytes[] memory results = new bytes[](calls.length);
            for (uint256 i; i < calls.length; ++i) {
                if (_selector(calls[i]) == this.multicall.selector) continue;
                results[i] = _tryAnswer(isParent, token, calls[i]);
            }
            return abi.encode(results);
        }
        revert UnsupportedResolverProfile(selector);
    }

    /// @dev Like `_answer` but yields empty bytes for an unsupported selector.
    function _tryAnswer(bool isParent, address token, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = _selector(data);
        if (
            selector != IAddrResolver.addr.selector && selector != IAddressResolver.addr.selector
                && selector != ITextResolver.text.selector
                && selector != IContentHashResolver.contenthash.selector
        ) return "";
        return _answer(isParent, token, data);
    }

    function _ethAddress(bool isParent, address token) internal view returns (address) {
        return isParent ? registry.platformAddress() : token;
    }

    function _coinAddress(bool isParent, address token, uint256 coinType)
        internal
        view
        returns (bytes memory)
    {
        if (coinType != COIN_TYPE_ETH) return "";
        address a = _ethAddress(isParent, token);
        return a == address(0) ? bytes("") : abi.encodePacked(a);
    }

    function _text(bool isParent, address token, string memory key)
        internal
        view
        returns (string memory)
    {
        if (isParent) return registry.parentText(key);
        if (token == address(0)) return "";
        if (keccak256(bytes(key)) == keccak256(bytes(LOGO_TEXT_KEY))) {
            bytes32 logoRef = registry.logoRefOf(token);
            if (logoRef != bytes32(0)) return _hex(logoRef);
        }
        return registry.text(token, key);
    }

    function _contenthash(bool isParent, address token) internal view returns (bytes memory) {
        if (isParent) return registry.defaultContenthash();
        if (token == address(0)) return "";
        return registry.contenthashOf(token);
    }

    // ------------------------------------------------------------------ curator agents

    /// @dev `agent.<parent>` is the index; `<label>.agent.<parent>` an agent (registered or not:
    ///      an unknown label answers zero values, like an unknown token).
    function _agentTarget(bytes calldata name)
        internal
        view
        returns (uint8 kind, uint8 categoryBit)
    {
        if (address(curators) == address(0)) {
            return (TARGET_NONE, 0);
        }
        if (name.length == _agentsDnsLength && keccak256(name) == _agentsDnsHash) {
            return (TARGET_AGENTS_INDEX, 0);
        }
        if (name.length == 0) return (TARGET_NONE, 0);
        uint256 len = uint8(name[0]);
        if (len == 0 || len > 63 || 1 + len + _agentsDnsLength != name.length) {
            return (TARGET_NONE, 0);
        }
        if (keccak256(name[1 + len:]) != _agentsDnsHash) return (TARGET_NONE, 0);
        (bool found, uint8 c) = curators.categoryOfLabelhash(keccak256(name[1:1 + len]));
        // An unregistered agent label still belongs to the agents namespace, never to a token.
        return (TARGET_AGENT, found ? c : type(uint8).max);
    }

    function _agentTargetOfNode(bytes32 node) internal view returns (uint8, uint8) {
        if (address(curators) == address(0)) return (TARGET_NONE, 0);
        if (node == curators.agentsNode()) return (TARGET_AGENTS_INDEX, 0);
        (bool found, uint8 c) = curators.categoryOfNode(node);
        return found ? (TARGET_AGENT, c) : (TARGET_NONE, 0);
    }

    function _agentAddress(uint8 kind, uint8 categoryBit) internal view returns (address) {
        if (kind == TARGET_AGENTS_INDEX) return address(curators);
        if (categoryBit == type(uint8).max) return address(0);
        return curators.agentOf(categoryBit).vault;
    }

    function _agentCoinAddress(uint8 kind, uint8 categoryBit, uint256 coinType)
        internal
        view
        returns (bytes memory)
    {
        if (coinType != COIN_TYPE_ETH) return "";
        address a = _agentAddress(kind, categoryBit);
        return a == address(0) ? bytes("") : abi.encodePacked(a);
    }

    function _agentText(uint8 kind, uint8 categoryBit, string memory key)
        internal
        view
        returns (string memory)
    {
        bytes32 k = keccak256(bytes(key));
        if (kind == TARGET_AGENTS_INDEX) {
            if (k == keccak256("url")) {
                return string.concat("https://agent.", _parentName, ".limo");
            }
            if (k == keccak256("description")) return "Verada curator agents";
            return "";
        }
        if (categoryBit == type(uint8).max) return "";
        ICuratorRegistry.Agent memory a = curators.agentOf(categoryBit);
        if (k == keccak256("url")) {
            return string.concat("https://", a.label, ".agent.", _parentName, ".limo");
        }
        if (k == keccak256("description")) return a.description;
        if (k == keccak256("verada.category")) return _decimal(categoryBit);
        if (k == keccak256("agent-registration")) {
            return string.concat(_agentRegistryPrefix, _decimal(a.agentId));
        }
        return "";
    }

    function _answerAgent(uint8 kind, uint8 categoryBit, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = _selector(data);
        if (selector == IAddrResolver.addr.selector) {
            return abi.encode(_agentAddress(kind, categoryBit));
        }
        if (selector == IAddressResolver.addr.selector) {
            (, uint256 coinType) = abi.decode(_args(data), (bytes32, uint256));
            return abi.encode(_agentCoinAddress(kind, categoryBit, coinType));
        }
        if (selector == ITextResolver.text.selector) {
            (, string memory key) = abi.decode(_args(data), (bytes32, string));
            return abi.encode(_agentText(kind, categoryBit, key));
        }
        if (selector == IContentHashResolver.contenthash.selector) {
            return abi.encode(registry.defaultContenthash());
        }
        if (selector == this.multicall.selector) {
            bytes[] memory calls = abi.decode(_args(data), (bytes[]));
            bytes[] memory results = new bytes[](calls.length);
            for (uint256 i; i < calls.length; ++i) {
                if (_selector(calls[i]) == this.multicall.selector) continue;
                results[i] = _tryAnswerAgent(kind, categoryBit, calls[i]);
            }
            return abi.encode(results);
        }
        revert UnsupportedResolverProfile(selector);
    }

    function _tryAnswerAgent(uint8 kind, uint8 categoryBit, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = _selector(data);
        if (
            selector != IAddrResolver.addr.selector && selector != IAddressResolver.addr.selector
                && selector != ITextResolver.text.selector
                && selector != IContentHashResolver.contenthash.selector
        ) return "";
        return _answerAgent(kind, categoryBit, data);
    }

    function _identityOf(ICuratorRegistry c) private view returns (address) {
        return ICuratorIdentity(address(c)).identityRegistry();
    }

    function _decimal(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        for (; v != 0; v /= 10) {
            // forge-lint: disable-next-line(unsafe-typecast)
            out[--digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(out);
    }

    /// @dev Lowercase `0x`-prefixed hex of an address (40 hex digits).
    function _addressHex(address a) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes20 w = bytes20(a);
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 20; ++i) {
            uint8 b = uint8(w[i]);
            out[2 + 2 * i] = digits[b >> 4];
            out[3 + 2 * i] = digits[b & 0x0f];
        }
        return string(out);
    }

    /// @dev Lowercase `0x`-prefixed hex of a 32-byte word (64 hex digits).
    function _hex(bytes32 word) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(word[i]);
            out[2 + 2 * i] = digits[b >> 4];
            out[3 + 2 * i] = digits[b & 0x0f];
        }
        return string(out);
    }

    /// @dev First four bytes of `data`, zero-padded when shorter.
    function _selector(bytes memory data) internal pure returns (bytes4) {
        // truncation is the point: only the selector is wanted
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(data);
    }

    /// @dev `data` without its 4-byte selector; callers have already matched the selector.
    function _args(bytes memory data) internal pure returns (bytes memory args) {
        uint256 n = data.length - 4;
        args = new bytes(n);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            mcopy(add(args, 0x20), add(data, 0x24), n)
        }
    }
}
