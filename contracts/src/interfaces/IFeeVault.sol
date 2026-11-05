// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEpochGovernor} from "./IEpochGovernor.sol";

/// @title IFeeVault
/// @notice Receives fees already consolidated into the settlement asset (USDC) and splits them
///         between the platform and a per-token cause pool.
interface IFeeVault {
    /// @notice Emitted once per deposit (one consolidation swap) with its totals. The cause
    ///         amount may be spread over several epochs: see `FeesAttributed`.
    /// @param token The launched token the fees belong to.
    /// @param platformAmount Amount credited to the platform.
    /// @param causeAmount Amount credited to the token's cause pool.
    /// @param currency The settlement asset the amounts are denominated in.
    event FeesCollected(
        address indexed token, uint256 platformAmount, uint256 causeAmount, address currency
    );

    /// @notice Emitted for every part of a deposit: the epoch whose cause pool received
    ///         `causeAmount`. The parts of one deposit sum to its `FeesCollected.causeAmount`.
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
    /// @notice Fees earned in or before `epoch` are still outside the vault (uncollected LP fees
    ///         or held fees whose route fails) and `SETTLE_GRACE` has not passed.
    error FeesPending(address token, uint256 epoch);

    /// @notice Platform share of fees in basis points (single source of the split).
    function PLATFORM_SHARE_BPS() external view returns (uint256);

    /// @notice Time after an epoch's end during which it cannot be settled while fees earned in
    ///         it are still outstanding; afterwards such fees go to a later epoch.
    function SETTLE_GRACE() external view returns (uint256);

    /// @notice The settlement asset (USDC) held by the vault.
    function settlementAsset() external view returns (address);

    /// @notice Registers a token. Callable by the factory only.
    function registerToken(address token) external;

    /// @notice Splits and records the settlement asset already transferred to the vault, given
    ///         as parts by the epoch in which they were earned. Callable by the fee consolidator
    ///         only.
    /// @dev Each part's cause share is credited to its accrual epoch, so the time of collection
    ///      does not choose the epoch. If that epoch is already settled, the share goes to the
    ///      first unsettled epoch after it. Emits one `FeesCollected` with the totals and one
    ///      `FeesAttributed` per non-zero part.
    /// @param accrualEpochs Epoch in which each part was earned; at most the current epoch.
    /// @param amounts Settlement asset amount of each part.
    function depositFees(
        address token,
        uint256[] calldata accrualEpochs,
        uint256[] calldata amounts
    ) external;

    /// @notice The governor whose epochs the vault settles against.
    function governor() external view returns (IEpochGovernor);

    /// @notice Platform balance accrued in the settlement asset.
    function platformAccrued() external view returns (uint256);

    /// @notice Cause pool balance of `token` in the settlement asset.
    function causePool(address token) external view returns (uint256);

    /// @notice Moves the cause pool of `token` to the distributor once `epoch` has a winner,
    ///         after bringing in the fees still outstanding for it (LP fees, held fees).
    ///         Reverts with `FeesPending` while those cannot be brought in, until `SETTLE_GRACE`
    ///         after the epoch's end.
    function settle(address token, uint256 epoch) external;

    /// @notice Withdraws accrued platform fees to the platform treasury.
    function withdrawPlatform() external;
}
