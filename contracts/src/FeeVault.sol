// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IDonationDistributor} from "./interfaces/IDonationDistributor.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";

/// @title FeeVault
/// @notice Receives fees already consolidated into the settlement asset (USDC), splits them
///         between the platform treasury and a per-token cause pool, and releases each epoch's
///         slice of a token's cause pool to the donation distributor once that epoch has a
///         winner.
/// @dev Only the fee consolidator can deposit, and only the settlement asset. Fees are
///      attributed to the epoch in which they were earned (the consolidator tags every raw
///      amount with its accrual epoch), not to the epoch in which a caller happens to collect,
///      retry or deposit them. Only that epoch's slice can be settled against that epoch's
///      result. Fees that arrive after their epoch was settled go to the first unsettled epoch
///      after it, so they are never stranded and the depositor still cannot pick the epoch.
///      Split math: the platform share is rounded down, so the cause pool always receives the
///      remainder. `platform + cause == amount` exactly for every deposit.
contract FeeVault is IFeeVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @inheritdoc IFeeVault
    uint256 public constant PLATFORM_SHARE_BPS = 1000;

    /// @notice Basis point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    error ZeroAddress();
    error NotFactory();
    error AlreadyRegistered(address token);
    error NothingToSettle(address token, uint256 epoch);
    error NothingToWithdraw();
    error ConsolidatorAlreadySet();
    error UnbackedDeposit(uint256 balance, uint256 required);

    event ConsolidatorSet(address indexed consolidator);

    /// @inheritdoc IFeeVault
    address public immutable settlementAsset;

    /// @notice The factory allowed to register tokens.
    address public immutable factory;

    /// @notice Platform treasury receiving the platform share.
    address public immutable platformTreasury;

    /// @notice Governor consulted for epoch winners.
    IEpochGovernor public immutable governor;

    /// @notice Distributor receiving settled cause pools.
    address public immutable distributor;

    /// @notice The only account allowed to call `depositFees`.
    address public consolidator;

    /// @notice Whether a token is registered.
    mapping(address token => bool registered) public isRegistered;

    /// @notice Whether `settle(token, epoch)` has been executed.
    mapping(address token => mapping(uint256 epoch => bool done)) public settled;

    /// @notice Total tracked (platform plus all cause pools) in the settlement asset.
    uint256 public totalTracked;

    uint256 private _platformAccrued;
    /// @dev Unsettled cause pool per token, across all epochs.
    mapping(address token => uint256 amount) private _causePool;
    /// @dev Cause pool attributed to the epoch in which the fees were earned.
    mapping(address token => mapping(uint256 epoch => uint256 amount)) private _epochPool;

    constructor(
        address owner_,
        address factory_,
        address platformTreasury_,
        IEpochGovernor governor_,
        address distributor_,
        address settlementAsset_
    ) Ownable(owner_) {
        if (
            factory_ == address(0) || platformTreasury_ == address(0)
                || address(governor_) == address(0) || distributor_ == address(0)
                || settlementAsset_ == address(0)
        ) revert ZeroAddress();
        factory = factory_;
        platformTreasury = platformTreasury_;
        governor = governor_;
        distributor = distributor_;
        settlementAsset = settlementAsset_;
    }

    /// @notice Sets the fee consolidator (once).
    function setConsolidator(address consolidator_) external onlyOwner {
        if (consolidator_ == address(0)) revert ZeroAddress();
        if (consolidator != address(0)) revert ConsolidatorAlreadySet();
        consolidator = consolidator_;
        emit ConsolidatorSet(consolidator_);
    }

    /// @inheritdoc IFeeVault
    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0)) revert ZeroAddress();
        if (isRegistered[token]) revert AlreadyRegistered(token);
        isRegistered[token] = true;
    }

    /// @notice Pure split of `amount` into platform and cause parts.
    /// @dev The platform part rounds down; the cause pool gets the remainder.
    function split(uint256 amount) public pure returns (uint256 platform, uint256 cause) {
        platform = (amount * PLATFORM_SHARE_BPS) / BPS_DENOMINATOR;
        cause = amount - platform;
    }

    /// @inheritdoc IFeeVault
    function depositFees(address token, uint256 amount, uint256 accrualEpoch) external {
        if (msg.sender != consolidator) revert NotAuthorized();
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (amount == 0) return;

        uint256 current = governor.currentEpoch();
        if (accrualEpoch > current) revert FutureEpoch(accrualEpoch, current);
        // A settled epoch cannot take more; the current epoch is never settled (it cannot be
        // finalized before it ends), so the walk always stops.
        uint256 epoch = accrualEpoch;
        while (epoch < current && settled[token][epoch]) {
            ++epoch;
        }

        (uint256 platform, uint256 cause) = split(amount);
        _platformAccrued += platform;
        _causePool[token] += cause;
        _epochPool[token][epoch] += cause;

        uint256 tracked = totalTracked + amount;
        totalTracked = tracked;

        // The funds must already be here; never credit what was not delivered.
        uint256 balance = IERC20(settlementAsset).balanceOf(address(this));
        if (balance < tracked) revert UnbackedDeposit(balance, tracked);

        emit FeesCollected(token, platform, cause, settlementAsset);
        emit FeesAttributed(token, epoch, accrualEpoch, cause);
    }

    /// @inheritdoc IFeeVault
    function platformAccrued() external view returns (uint256) {
        return _platformAccrued;
    }

    /// @inheritdoc IFeeVault
    /// @dev Total unsettled across all epochs; see `causePoolOf` for a single epoch.
    function causePool(address token) external view returns (uint256) {
        return _causePool[token];
    }

    /// @notice Cause pool of `token` attributed to `epoch` and not yet settled.
    function causePoolOf(address token, uint256 epoch) external view returns (uint256) {
        return _epochPool[token][epoch];
    }

    /// @inheritdoc IFeeVault
    function settle(address token, uint256 epoch) external nonReentrant {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (!governor.isFinalized(token, epoch)) revert EpochNotFinalized(token, epoch);
        if (settled[token][epoch]) revert AlreadySettled(token, epoch);

        uint256 amount = _epochPool[token][epoch];
        if (amount == 0) revert NothingToSettle(token, epoch);

        _epochPool[token][epoch] = 0;
        _causePool[token] -= amount;
        totalTracked -= amount;
        settled[token][epoch] = true;

        IERC20(settlementAsset).safeTransfer(distributor, amount);
        IDonationDistributor(distributor).receiveFunds(token, epoch, amount);
        emit Settled(token, epoch, settlementAsset, amount);
    }

    /// @inheritdoc IFeeVault
    /// @dev Permissionless: funds can only ever go to the platform treasury.
    function withdrawPlatform() external nonReentrant {
        uint256 amount = _platformAccrued;
        if (amount == 0) revert NothingToWithdraw();

        _platformAccrued = 0;
        totalTracked -= amount;

        IERC20(settlementAsset).safeTransfer(platformTreasury, amount);
        emit PlatformWithdrawn(settlementAsset, platformTreasury, amount);
    }
}
