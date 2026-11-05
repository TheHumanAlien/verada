// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {MockDistributor, MockERC20, MockGovernor} from "../consolidator/ConsolidatorMocks.sol";

/// @dev The vault credits the accrual epoch given by the consolidator, not the deposit epoch.
contract FeeVaultAttributionTest is Test {
    FeeVault vault;
    MockERC20 usdc;
    MockGovernor governor;
    MockDistributor distributor;

    address consolidator = makeAddr("consolidator");
    address token = makeAddr("token");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        governor = new MockGovernor();
        distributor = new MockDistributor();
        vault = new FeeVault(
            address(this),
            address(this),
            makeAddr("treasury"),
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        vault.setConsolidator(consolidator);
        vault.registerToken(token);
    }

    function _deposit(uint256 amount, uint256 accrualEpoch) internal {
        usdc.mint(address(vault), amount);
        vm.prank(consolidator);
        vault.depositFees(token, amount, accrualEpoch);
    }

    function _depositExpecting(uint256 amount, uint256 accrualEpoch, uint256 credited) internal {
        usdc.mint(address(vault), amount);
        (, uint256 cause) = vault.split(amount);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IFeeVault.FeesAttributed(token, credited, accrualEpoch, cause);
        vm.prank(consolidator);
        vault.depositFees(token, amount, accrualEpoch);
    }

    function test_exposesGovernor() public view {
        assertEq(address(vault.governor()), address(governor));
    }

    function test_depositCreditsAccrualEpoch() public {
        governor.setCurrentEpoch(5);
        _depositExpecting(1000, 2, 2);
        assertEq(vault.causePoolOf(token, 2), 900);
        assertEq(vault.causePoolOf(token, 5), 0);
        assertEq(vault.causePool(token), 900);
    }

    function test_depositForFutureEpochReverts() public {
        governor.setCurrentEpoch(5);
        usdc.mint(address(vault), 1000);
        vm.prank(consolidator);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FutureEpoch.selector, 6, 5));
        vault.depositFees(token, 1000, 6);
    }

    function test_lateDepositSkipsSettledEpochs() public {
        governor.setCurrentEpoch(6);
        _deposit(1000, 2);
        _deposit(1000, 3);
        governor.setFinalized(token, 2, true);
        governor.setFinalized(token, 3, true);
        vault.settle(token, 2);
        vault.settle(token, 3);

        _depositExpecting(500, 2, 4);
        assertEq(vault.causePoolOf(token, 4), 450);
        assertEq(vault.causePoolOf(token, 6), 0);

        // Epoch 4 can now be settled for its winner; nothing is stranded.
        governor.setFinalized(token, 4, true);
        vault.settle(token, 4);
        assertEq(distributor.received(token, 4), 450);
    }

    /// The current epoch is the last stop even if a governor reported it as settled.
    function test_lateDepositStopsAtCurrentEpoch() public {
        governor.setCurrentEpoch(1);
        _deposit(1000, 0);
        governor.setFinalized(token, 0, true);
        vault.settle(token, 0);
        _deposit(1000, 0);
        assertEq(vault.causePoolOf(token, 1), 900);
    }
}
