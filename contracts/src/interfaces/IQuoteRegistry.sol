// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IQuoteRegistry
/// @notice Allowlist of assets a token's pool may be paired against (WETH or an Ondo token).
interface IQuoteRegistry {
    /// @notice Classification of a quote asset.
    enum Kind {
        Native, // WETH
        Ondo // Ondo tokenized asset on Ethereum mainnet
    }

    /// @notice A registered quote asset.
    struct QuoteAsset {
        uint8 decimals;
        Kind kind;
        bool active;
    }

    event QuoteAssetAdded(address indexed asset, uint8 decimals, Kind kind);
    event QuoteAssetDeactivated(address indexed asset);
    event QuoteAssetReactivated(address indexed asset);

    error QuoteAssetAlreadyExists(address asset);
    error QuoteAssetNotFound(address asset);
    error ZeroAddress();

    /// @notice Adds a quote asset; decimals are read from the token by the implementation.
    function addQuoteAsset(address asset, Kind kind) external;

    /// @notice Disables new launches against `asset`; existing pools are unaffected.
    function deactivateQuoteAsset(address asset) external;

    /// @notice Re-enables a previously deactivated asset.
    function reactivateQuoteAsset(address asset) external;

    /// @notice Returns the registered data for `asset` (zeroed if unknown).
    function getQuoteAsset(address asset) external view returns (QuoteAsset memory);

    /// @notice Whether `asset` is registered and active.
    function isAllowed(address asset) external view returns (bool);

    /// @notice Number of quote assets ever added.
    function quoteAssetCount() external view returns (uint256);

    /// @notice Quote asset at `index` in insertion order.
    function quoteAssetAt(uint256 index) external view returns (address);
}
