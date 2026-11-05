// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {
    MockDistributor,
    MockERC20,
    MockFlushConsolidator,
    MockGovernor,
    single
} from "../consolidator/ConsolidatorMocks.sol";

/// @dev Drives the vault as the consolidator would: deposits across epochs and tokens, platform
///      withdrawals and epoch settlements, tracking ghost totals for value conservation.
contract VaultHandler is Test {
    FeeVault public vault;
    MockGovernor public governor;
    MockERC20 public usdc;
    address public consolidator;
    address[] public tokens;

    uint256 public totalIn;
    uint256 public totalPlatformOut;
    uint256 public totalSettledOut;
    uint256 public splitViolations;
    uint256 public attributionViolations;

    constructor(
        FeeVault v,
        MockGovernor g,
        MockERC20 u,
        address consolidator_,
        address[] memory toks
    ) {
        vault = v;
        governor = g;
        usdc = u;
        consolidator = consolidator_;
        tokens = toks;
    }

    function deposit(uint256 tokenSeed, uint96 amount, uint256 epochSeed) external {
        address t = tokens[tokenSeed % tokens.length];
        usdc.mint(address(vault), amount);
        // Fees may arrive late: any accrual epoch up to the current one.
        uint256 accrual = epochSeed % (governor.currentEpoch() + 1);

        uint256 platformBefore = vault.platformAccrued();
        uint256 poolBefore = vault.causePool(t);
        bool accrualSettled = vault.settled(t, accrual);
        uint256 accrualPoolBefore = vault.causePoolOf(t, accrual);
        vm.prank(consolidator);
        vault.depositFees(t, single(accrual), single(amount));
        // A settled epoch never takes more; an unsettled accrual epoch takes the whole share.
        uint256 accrualGain = vault.causePoolOf(t, accrual) - accrualPoolBefore;
        if (accrualSettled && accrualGain != 0) attributionViolations++;
        if (!accrualSettled && accrualGain != vault.causePool(t) - poolBefore) {
            attributionViolations++;
        }
        uint256 platformDelta = vault.platformAccrued() - platformBefore;
        uint256 poolDelta = vault.causePool(t) - poolBefore;

        if (platformDelta + poolDelta != amount) splitViolations++;
        // Platform rounds down: never above 10% of the input.
        if (platformDelta > uint256(amount) / 10) splitViolations++;
        totalIn += amount;
    }

    function advanceEpoch() external {
        governor.setCurrentEpoch(governor.currentEpoch() + 1);
    }

    function withdrawPlatform() external {
        uint256 amt = vault.platformAccrued();
        if (amt == 0) return;
        vault.withdrawPlatform();
        totalPlatformOut += amt;
    }

    function settle(uint256 tokenSeed, uint256 epochSeed) external {
        address t = tokens[tokenSeed % tokens.length];
        uint256 current = governor.currentEpoch();
        if (current == 0) return;
        // Like the governor, only an epoch that has ended can be finalized.
        uint256 epoch = epochSeed % current;
        uint256 amt = vault.causePoolOf(t, epoch);
        if (amt == 0) return;
        governor.setFinalized(t, epoch, true);
        vault.settle(t, epoch);
        totalSettledOut += amt;
    }
}

contract VaultInvariantTest is Test {
    FeeVault vault;
    MockERC20 usdc;
    MockDistributor distributor;
    VaultHandler handler;
    address[] tokens;

    address factory = makeAddr("factory");
    address treasury = makeAddr("treasury");
    address consolidator = address(new MockFlushConsolidator());

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        MockGovernor governor = new MockGovernor();
        distributor = new MockDistributor();
        vault = new FeeVault(
            address(this),
            factory,
            treasury,
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        vault.setConsolidator(consolidator);
        for (uint256 i; i < 3; ++i) {
            address t = address(uint160(0x1000 + i));
            tokens.push(t);
            vm.prank(factory);
            vault.registerToken(t);
        }

        handler = new VaultHandler(vault, governor, usdc, consolidator, tokens);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](4);
        sels[0] = VaultHandler.deposit.selector;
        sels[1] = VaultHandler.advanceEpoch.selector;
        sels[2] = VaultHandler.withdrawPlatform.selector;
        sels[3] = VaultHandler.settle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function _sumPools() internal view returns (uint256 s) {
        for (uint256 i; i < tokens.length; ++i) {
            s += vault.causePool(tokens[i]);
        }
    }

    /// The vault balance always covers platform plus every cause pool, exactly.
    function invariant_accountingConserved() public view {
        assertEq(usdc.balanceOf(address(vault)), vault.platformAccrued() + _sumPools());
        assertEq(vault.totalTracked(), usdc.balanceOf(address(vault)));
    }

    /// Everything that came in is either held, paid to the treasury, or paid to the distributor.
    function invariant_valueConservation() public view {
        assertEq(
            usdc.balanceOf(address(vault)) + usdc.balanceOf(treasury)
                + usdc.balanceOf(address(distributor)),
            handler.totalIn()
        );
        assertEq(usdc.balanceOf(treasury), handler.totalPlatformOut());
        assertEq(usdc.balanceOf(address(distributor)), handler.totalSettledOut());
    }

    /// The split sums exactly and rounding never favours the platform.
    function invariant_splitExact() public view {
        assertEq(handler.splitViolations(), 0);
    }

    /// Fees land in their accrual epoch, or past it only when that epoch is already settled.
    function invariant_feesLandInAccrualEpoch() public view {
        assertEq(handler.attributionViolations(), 0);
    }
}
