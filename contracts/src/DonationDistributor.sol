// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IDonationDistributor} from "./interfaces/IDonationDistributor.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IEndaomentOrg} from "./interfaces/external/IEndaomentOrg.sol";
import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";
import {IEndaomentRegistry} from "./interfaces/external/IEndaomentRegistry.sol";

/// @title DonationDistributor
/// @notice Holds the settlement asset (USDC) per (token, epoch) and donates it to the epoch's
///         winning Endaoment org once the epoch is finalized.
/// @dev The fee vault transfers USDC here and then calls `receiveFunds`; solvency is checked on
///      every receipt. `distribute` is permissionless and atomic: either the whole epoch amount
///      reaches the org or nothing changes. The org is deployed on demand (decided by on-chain
///      code length, never by an API cache). Allowances are granted for exactly the donated
///      amount and cleared afterwards. The Endaoment fee is read from the registry and is taken
///      by Endaoment out of the gross amount sent.
contract DonationDistributor is IDonationDistributor, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IEpochGovernor public immutable governor;
    ICauseRegistry public immutable registry;
    /// @notice Endaoment OrgFundFactory (deploys orgs, derives their CREATE2 addresses).
    IEndaomentOrgFundFactory public immutable endaomentFactory;
    /// @notice Endaoment registry (active-entity and fee lookups), read from the factory.
    IEndaomentRegistry public immutable endaomentRegistry;
    /// @inheritdoc IDonationDistributor
    address public immutable settlementAsset;

    /// @notice Fee vault allowed to credit funds (set once by the owner).
    address public feeVault;

    event FeeVaultSet(address indexed feeVault);

    error ZeroAddress();
    error FeeVaultAlreadySet();
    error InsufficientBalance();
    error AllowanceNotCleared(address spender);

    mapping(address token => mapping(uint256 epoch => bool)) public distributed;
    /// @inheritdoc IDonationDistributor
    mapping(address token => mapping(uint256 epoch => uint256)) public pending;
    /// @notice Total recorded-but-undonated settlement asset across all epochs.
    uint256 public reserved;

    constructor(
        address initialOwner,
        IEpochGovernor governor_,
        ICauseRegistry registry_,
        IEndaomentOrgFundFactory endaomentFactory_
    ) Ownable(initialOwner) {
        if (
            address(governor_) == address(0) || address(registry_) == address(0)
                || address(endaomentFactory_) == address(0)
        ) revert ZeroAddress();
        governor = governor_;
        registry = registry_;
        endaomentFactory = endaomentFactory_;
        endaomentRegistry = IEndaomentRegistry(endaomentFactory_.registry());
        settlementAsset = endaomentFactory_.baseToken();
        if (address(endaomentRegistry) == address(0) || settlementAsset == address(0)) {
            revert ZeroAddress();
        }
    }

    /// @notice Sets the fee vault. Can only be done once.
    function setFeeVault(address feeVault_) external onlyOwner {
        if (feeVault != address(0)) revert FeeVaultAlreadySet();
        if (feeVault_ == address(0)) revert ZeroAddress();
        feeVault = feeVault_;
        emit FeeVaultSet(feeVault_);
    }

    /// @inheritdoc IDonationDistributor
    /// @dev `amount` must already have been transferred to this contract.
    function receiveFunds(address token, uint256 epoch, uint256 amount) external {
        if (msg.sender != feeVault) revert NotFeeVault();
        if (distributed[token][epoch]) revert AlreadyDistributed(token, epoch);
        if (amount == 0) return;

        uint256 newReserved = reserved + amount;
        if (IERC20(settlementAsset).balanceOf(address(this)) < newReserved) {
            revert InsufficientBalance();
        }
        reserved = newReserved;
        pending[token][epoch] += amount;
    }

    /// @inheritdoc IDonationDistributor
    function distribute(address token, uint256 epoch) external nonReentrant {
        if (!governor.isFinalized(token, epoch)) revert EpochNotFinalized(token, epoch);
        if (distributed[token][epoch]) revert AlreadyDistributed(token, epoch);

        uint256 amount = pending[token][epoch];
        if (amount == 0) revert NothingToDistribute(token, epoch);

        bytes32 causeId = governor.winningCause(token, epoch);
        ICauseRegistry.Cause memory cause = registry.getCause(causeId);

        // The stored address must still be the factory's address for this org id.
        address expected = endaomentFactory.computeOrgAddress(cause.orgId);
        if (expected != cause.orgAddress) {
            revert OrgAddressMismatch(cause.orgId, expected, cause.orgAddress);
        }

        // Effects before interactions.
        distributed[token][epoch] = true;
        pending[token][epoch] = 0;
        reserved -= amount;

        address org = cause.orgAddress;
        IERC20 usdc = IERC20(settlementAsset);

        if (org.code.length == 0) {
            usdc.forceApprove(address(endaomentFactory), amount);
            address deployed = endaomentFactory.deployOrgAndDonate(cause.orgId, amount);
            if (deployed != org) revert OrgAddressMismatch(cause.orgId, org, deployed);
            _requireCleared(usdc, address(endaomentFactory));
            emit OrgDeployed(cause.orgId, org);
        } else {
            if (!endaomentRegistry.isActiveEntity(org)) revert OrgNotActive(org);
            usdc.forceApprove(org, amount);
            IEndaomentOrg(org).donate(amount);
            _requireCleared(usdc, org);
        }

        emit Donated(token, epoch, causeId, org, amount);
    }

    /// @inheritdoc IDonationDistributor
    function endaomentFeeFor(address org) external view returns (uint32) {
        return endaomentRegistry.getDonationFee(org);
    }

    /// @dev Both Endaoment entry points pull the exact approved amount, so the allowance is
    ///      already zero. If a changed implementation pulled less, clear the remainder.
    function _requireCleared(IERC20 usdc, address spender) private {
        if (usdc.allowance(address(this), spender) != 0) {
            usdc.forceApprove(spender, 0);
            if (usdc.allowance(address(this), spender) != 0) revert AllowanceNotCleared(spender);
        }
    }
}
