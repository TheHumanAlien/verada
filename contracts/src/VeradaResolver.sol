// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "./interfaces/external/ens/IEnsResolverProfiles.sol";
import {DnsNameLib} from "./libraries/DnsNameLib.sol";

/// @title VeradaResolver
/// @notice Stateless ENSIP-10 wildcard resolver for the Verada parent name and every
///         `<label>.<parent>` registered in the `TokenProfileRegistry`. The parent resolves to the
///         platform address and the default site contenthash; a child resolves to its token
///         address, its text records (with `verada.logo` synthesized from the logo reference) and
///         its contenthash override or the default. Unknown and suppressed labels resolve to
///         zero values rather than reverting, so clients see "no record" instead of an error.
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
    constructor(ITokenProfileRegistry registry_, bytes memory parentDnsName) {
        registry = registry_;
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
        (bool isParent, address token) = _lookup(node);
        return payable(_ethAddress(isParent, token));
    }

    /// @inheritdoc IAddressResolver
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        (bool isParent, address token) = _lookup(node);
        return _coinAddress(isParent, token, coinType);
    }

    /// @inheritdoc ITextResolver
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        (bool isParent, address token) = _lookup(node);
        return _text(isParent, token, key);
    }

    /// @inheritdoc IContentHashResolver
    function contenthash(bytes32 node) external view returns (bytes memory) {
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
