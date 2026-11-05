// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEpochGovernor} from "./IEpochGovernor.sol";

/// @title IFeeVault
/// @notice Receives fees already consolidated into the settlement asset (USDC) and splits them
///         between the platform and a per-token cause pool.
interface IFeeVault {
    /// @notice Emitted when consolidated fees are split and credited.
    /// @param token The launched token the fees belong to.
    /// @param platformAmount Amount credited to the platform.
    /// @param causeAmount Amount credited to the token's cause pool.
    /// @param currency The settlement asset the amounts are denominated in.
    event FeesCollected(
        address indexed token, uint256 platformAmount, uint256 causeAmount, address currency
    );

    /// @notice Emitted with every deposit: the epoch whose cause pool received `causeAmount`.
    /// @param epoch The epoch credited (the accrual epoch, or the first unsettled one after it).
    /// @param accrualEpoch The epoch in which the fees were earned.
    event FeesAttributed(
        address indexed token, uint256 indexed epoch, uint256 accrualEpoch, uint256 causeAmount
    );

    /// @notice Emitted when a cause pool is moved to the distributor.
    event Settled(address indexed token, uint256 indexed epoch, address currency, uint256 amount);

    /// @notice Emitted when the platform withdraws accrued fees.
    event PlatformWithdrawn(address indexed currency, address indexed to, uint256 amount);

    error NotAuthorized();
    error EpochNotFinalized(address token, uint256 epoch);
    error AlreadySettled(address token, uint256 epoch);
    error TokenNotRegistered(address token);
    error FutureEpoch(uint256 epoch, uint256 current);

    /// @notice Platform share of fees in basis points (single source of the split).
    function PLATFORM_SHARE_BPS() external view returns (uint256);

    /// @notice The settlement asset (USDC) held by the vault.
    function settlementAsset() external view returns (address);

    /// @notice Registers a token. Callable by the factory only.
    function registerToken(address token) external;

    /// @notice Splits and records `amount` of the settlement asset already transferred to the
    ///         vault. Callable by the fee consolidator only.
    /// @dev The cause share is credited to `accrualEpoch`, the epoch in which the fees were
    ///      earned, so the time of collection does not choose the epoch. If that epoch is already
    ///      settled, the share goes to the first unsettled epoch after it.
    /// @param accrualEpoch Epoch in which the fees were earned; at most the current epoch.
    function depositFees(address token, uint256 amount, uint256 accrualEpoch) external;

    /// @notice The governor whose epochs the vault settles against.
    function governor() external view returns (IEpochGovernor);

    /// @notice Platform balance accrued in the settlement asset.
    function platformAccrued() external view returns (uint256);

    /// @notice Cause pool balance of `token` in the settlement asset.
    function causePool(address token) external view returns (uint256);

    /// @notice Moves the cause pool of `token` to the distributor once `epoch` has a winner.
    function settle(address token, uint256 epoch) external;

    /// @notice Withdraws accrued platform fees to the platform treasury.
    function withdrawPlatform() external;
}
