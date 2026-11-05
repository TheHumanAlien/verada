// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ILpLocker
/// @notice Holds liquidity position NFTs permanently. Principal can never be withdrawn.
interface ILpLocker {
    /// @notice Emitted when a position is locked.
    event Locked(address indexed token, uint256 indexed lpTokenId);

    error NotFactory();
    error AlreadyLocked(address token);
    error NotLocked(address token);

    /// @notice Records a position NFT as locked for `token`. Callable by the factory only.
    function lock(address token, uint256 lpTokenId) external;

    /// @notice Position NFT id locked for `token`.
    function lpTokenIdOf(address token) external view returns (uint256);

    /// @notice Pulls accrued LP fees of `token` to the fee vault.
    /// @return amount0 Amount of currency0 collected.
    /// @return amount1 Amount of currency1 collected.
    function collectFees(address token) external returns (uint256 amount0, uint256 amount1);

    /// @notice When the fees of `token`'s position were last collected (or it was locked); zero
    ///         if no position is locked for it. Fees collected later were earned since then.
    function lastCollectedAt(address token) external view returns (uint256);
}
