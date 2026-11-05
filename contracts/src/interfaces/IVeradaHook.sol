// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVeradaHook
/// @notice Uniswap v4 hook: dynamic LP fee with anti-sniper decay, and fee capture after swaps.
///         Raw fees are forwarded to the fee consolidator, which swaps them to the settlement asset.
interface IVeradaHook {
    /// @notice Per-token fee configuration.
    struct FeeConfig {
        uint24 baseFeeBps;
        uint24 sniperFeeStartBps;
        uint32 sniperDecaySeconds;
        uint40 launchTimestamp;
    }

    error NotFactory();
    error TokenNotConfigured(address token);
    error AlreadyConfigured(address token);

    /// @notice Registers fee parameters for a token's pool. Callable by the factory only.
    function configureToken(address token, FeeConfig calldata config) external;

    /// @notice Fee configuration of `token`.
    function feeConfig(address token) external view returns (FeeConfig memory);

    /// @notice Current total fee in basis points (base plus decayed surcharge) for `token`.
    function currentFeeBps(address token) external view returns (uint24);

    /// @notice The consolidator receiving raw captured fees (the hook never talks to the vault).
    function feeConsolidator() external view returns (address);
}
