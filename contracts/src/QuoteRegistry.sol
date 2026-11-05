// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {IQuoteRegistry} from "./interfaces/IQuoteRegistry.sol";

/// @title QuoteRegistry
/// @notice Owner-managed allowlist of assets a token's pool may be paired against (WETH and
///         verified Ondo tokens), plus the Uniswap v4 route that converts each asset into the
///         settlement asset (USDC).
/// @dev A route is an ordered list of pool keys. Starting from the quote asset, every hop
///      swaps the current currency for the other currency of the pool, and the last hop must
///      end in the settlement asset. One special case is allowed: when the current currency is
///      WETH and the next pool is quoted in native ETH (currency address zero) instead, the
///      consolidator unwraps first. Deactivating an asset blocks new launches only; the route is
///      kept so existing pools keep consolidating.
contract QuoteRegistry is IQuoteRegistry, Ownable2Step {
    /// @notice Maximum hops in a route.
    uint256 public constant MAX_ROUTE_LENGTH = 3;

    /// @notice The settlement asset (USDC) every route must end in.
    address public immutable settlementAsset;

    /// @notice Wrapped native asset, used for the unwrap special case.
    address public immutable weth;

    mapping(address asset => QuoteAsset data) private _assets;
    mapping(address asset => bool exists) private _exists;
    mapping(address asset => PoolKey[] hops) private _routes;
    address[] private _list;

    event RouteSet(address indexed asset, uint256 hops);

    error EmptyRoute();
    error RouteTooLong(uint256 length);
    error RouteDisconnected(uint256 hop);
    error RouteDoesNotSettle(address endsIn);
    error AssetIsSettlement();
    error InvalidDecimals(address asset);

    constructor(address owner_, address settlementAsset_, address weth_) Ownable(owner_) {
        if (settlementAsset_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        settlementAsset = settlementAsset_;
        weth = weth_;
    }

    // ------------------------------------------------------------------ allowlist

    /// @inheritdoc IQuoteRegistry
    function addQuoteAsset(address asset, Kind kind) external onlyOwner {
        _add(asset, kind);
    }

    /// @notice Adds a quote asset together with its route to the settlement asset.
    function addQuoteAssetWithRoute(address asset, Kind kind, PoolKey[] calldata route)
        external
        onlyOwner
    {
        _add(asset, kind);
        _setRoute(asset, route);
    }

    /// @inheritdoc IQuoteRegistry
    function deactivateQuoteAsset(address asset) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _assets[asset].active = false;
        emit QuoteAssetDeactivated(asset);
    }

    /// @inheritdoc IQuoteRegistry
    function reactivateQuoteAsset(address asset) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _assets[asset].active = true;
        emit QuoteAssetReactivated(asset);
    }

    /// @inheritdoc IQuoteRegistry
    function getQuoteAsset(address asset) external view returns (QuoteAsset memory) {
        return _assets[asset];
    }

    /// @inheritdoc IQuoteRegistry
    function isAllowed(address asset) external view returns (bool) {
        return _assets[asset].active;
    }

    /// @inheritdoc IQuoteRegistry
    function quoteAssetCount() external view returns (uint256) {
        return _list.length;
    }

    /// @inheritdoc IQuoteRegistry
    function quoteAssetAt(uint256 index) external view returns (address) {
        return _list[index];
    }

    // ------------------------------------------------------------------ routes

    /// @notice Replaces the route that converts `asset` into the settlement asset.
    function setRoute(address asset, PoolKey[] calldata route) external onlyOwner {
        if (!_exists[asset]) revert QuoteAssetNotFound(asset);
        _setRoute(asset, route);
    }

    /// @notice The route of `asset` (empty when none is configured).
    function routeOf(address asset) external view returns (PoolKey[] memory) {
        return _routes[asset];
    }

    /// @notice Number of hops in the route of `asset`.
    function routeLength(address asset) external view returns (uint256) {
        return _routes[asset].length;
    }

    /// @notice Whether a route to the settlement asset is configured for `asset`.
    function hasRoute(address asset) external view returns (bool) {
        return _routes[asset].length != 0;
    }

    // ------------------------------------------------------------------ internals

    function _add(address asset, Kind kind) private {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == settlementAsset) revert AssetIsSettlement();
        if (_exists[asset]) revert QuoteAssetAlreadyExists(asset);
        uint8 decimals_ = IERC20Metadata(asset).decimals();
        if (decimals_ == 0 || decimals_ > 36) revert InvalidDecimals(asset);

        _exists[asset] = true;
        _assets[asset] = QuoteAsset({decimals: decimals_, kind: kind, active: true});
        _list.push(asset);
        emit QuoteAssetAdded(asset, decimals_, kind);
    }

    function _setRoute(address asset, PoolKey[] calldata route) private {
        uint256 length = route.length;
        if (length == 0) revert EmptyRoute();
        if (length > MAX_ROUTE_LENGTH) revert RouteTooLong(length);

        address current = asset;
        delete _routes[asset];
        for (uint256 i; i < length; ++i) {
            PoolKey calldata key = route[i];
            address c0 = Currency.unwrap(key.currency0);
            address c1 = Currency.unwrap(key.currency1);
            if (current == c0) {
                current = c1;
            } else if (current == c1) {
                current = c0;
            } else if (current == weth && (c0 == address(0) || c1 == address(0))) {
                // Unwrap special case: the pool is quoted in native ETH.
                current = c0 == address(0) ? c1 : c0;
            } else {
                revert RouteDisconnected(i);
            }
            _routes[asset].push(key);
        }
        if (current != settlementAsset) revert RouteDoesNotSettle(current);
        emit RouteSet(asset, length);
    }
}
