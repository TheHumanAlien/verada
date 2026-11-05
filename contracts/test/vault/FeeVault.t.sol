// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {
    MockDistributor,
    MockERC20,
    MockFlushConsolidator,
    MockGovernor,
    single
} from "../consolidator/ConsolidatorMocks.sol";

contract FeeVaultTest is Test {
    FeeVault vault;
    MockERC20 usdc;
    MockGovernor governor;
    MockDistributor distributor;

    address owner = makeAddr("owner");
    address factory = makeAddr("factory");
    address treasury = makeAddr("treasury");
    address consolidator = address(new MockFlushConsolidator());
    address tokenA = makeAddr("tokenA");
    address tokenB = makeAddr("tokenB");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        governor = new MockGovernor();
        distributor = new MockDistributor();
        vault = new FeeVault(
            owner,
            factory,
            treasury,
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        vm.prank(owner);
        vault.setConsolidator(consolidator);
        vm.startPrank(factory);
        vault.registerToken(tokenA);
        vault.registerToken(tokenB);
        vm.stopPrank();
    }

    function _deposit(address token, uint256 amt) internal {
        usdc.mint(address(vault), amt);
        uint256 epoch = governor.currentEpoch();
        vm.prank(consolidator);
        vault.depositFees(token, single(epoch), single(amt));
    }

    function test_shareConstant() public view {
        assertEq(vault.PLATFORM_SHARE_BPS(), 1000);
        assertEq(vault.settlementAsset(), address(usdc));
    }

    function test_constructorRejectsZero() public {
        IEpochGovernor g = IEpochGovernor(address(governor));
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        new FeeVault(owner, factory, treasury, g, address(distributor), address(0));
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        new FeeVault(owner, address(0), treasury, g, address(distributor), address(usdc));
    }

    function test_splitTenNinety() public {
        _deposit(tokenA, 1000e6);
        assertEq(vault.platformAccrued(), 100e6);
        assertEq(vault.causePool(tokenA), 900e6);
    }

    function test_splitRoundsInFavourOfCause() public {
        _deposit(tokenA, 9);
        assertEq(vault.platformAccrued(), 0);
        assertEq(vault.causePool(tokenA), 9);
        _deposit(tokenA, 19);
        assertEq(vault.platformAccrued(), 1);
    }

    function test_emitsFeesCollectedWithUsdc() public {
        usdc.mint(address(vault), 100);
        vm.expectEmit(true, false, false, true);
        emit IFeeVault.FeesCollected(tokenA, 10, 90, address(usdc));
        vm.prank(consolidator);
        vault.depositFees(tokenA, single(0), single(100));
    }

    function test_perTokenPools() public {
        _deposit(tokenA, 100);
        _deposit(tokenB, 300);
        assertEq(vault.causePool(tokenA), 90);
        assertEq(vault.causePool(tokenB), 270);
        assertEq(vault.platformAccrued(), 10 + 30);
    }

    function test_onlyConsolidatorDeposits() public {
        usdc.mint(address(vault), 1);
        vm.expectRevert(IFeeVault.NotAuthorized.selector);
        vault.depositFees(tokenA, single(0), single(1));
        vm.prank(owner);
        vm.expectRevert(IFeeVault.NotAuthorized.selector);
        vault.depositFees(tokenA, single(0), single(1));
    }

    function test_consolidatorSetOnceByOwner() public {
        vm.expectRevert();
        vault.setConsolidator(address(9));
        vm.prank(owner);
        vm.expectRevert(FeeVault.ConsolidatorAlreadySet.selector);
        vault.setConsolidator(address(9));
        FeeVault v2 = new FeeVault(
            owner,
            factory,
            treasury,
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        vm.prank(owner);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v2.setConsolidator(address(0));
        // Before it is set nobody can deposit.
        vm.expectRevert(IFeeVault.NotAuthorized.selector);
        v2.depositFees(tokenA, single(0), single(1));
    }

    function test_revertUnregisteredToken() public {
        usdc.mint(address(vault), 1);
        vm.prank(consolidator);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.TokenNotRegistered.selector, address(1)));
        vault.depositFees(address(1), single(0), single(1));
    }

    function test_revertUnbackedDeposit() public {
        vm.prank(consolidator);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.UnbackedDeposit.selector, 0, 100));
        vault.depositFees(tokenA, single(0), single(100));
    }

    function test_otherAssetsDoNotBackDeposits() public {
        MockERC20 other = new MockERC20("OTHER", 18);
        other.mint(address(vault), 1000e18);
        vm.prank(consolidator);
        vm.expectRevert();
        vault.depositFees(tokenA, single(0), single(100));
    }

    function test_zeroDepositNoop() public {
        vm.prank(consolidator);
        vault.depositFees(tokenA, single(0), single(0));
        assertEq(vault.totalTracked(), 0);
    }

    function test_onlyFactoryRegisters() public {
        vm.expectRevert(FeeVault.NotFactory.selector);
        vault.registerToken(address(5));
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.AlreadyRegistered.selector, tokenA));
        vault.registerToken(tokenA);
    }

    function test_withdrawPlatformToTreasury() public {
        _deposit(tokenA, 1000);
        vault.withdrawPlatform();
        assertEq(usdc.balanceOf(treasury), 100);
        assertEq(vault.platformAccrued(), 0);
        assertEq(usdc.balanceOf(address(vault)), 900);
        vm.expectRevert(FeeVault.NothingToWithdraw.selector);
        vault.withdrawPlatform();
    }

    function test_settleRequiresWinner() public {
        governor.setCurrentEpoch(3);
        _deposit(tokenA, 1000);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.EpochNotFinalized.selector, tokenA, 3));
        vault.settle(tokenA, 3);
    }

    function test_settleMovesCausePool() public {
        governor.setCurrentEpoch(3);
        _deposit(tokenA, 1000);
        governor.setFinalized(tokenA, 3, true);
        vm.expectEmit(true, true, false, true);
        emit IFeeVault.Settled(tokenA, 3, address(usdc), 900);
        vault.settle(tokenA, 3);
        assertEq(distributor.received(tokenA, 3), 900);
        assertEq(usdc.balanceOf(address(distributor)), 900);
        assertEq(vault.causePool(tokenA), 0);
        assertEq(vault.platformAccrued(), 100); // platform share untouched
    }

    function test_settleOnlyAffectsThatToken() public {
        governor.setCurrentEpoch(1);
        _deposit(tokenA, 1000);
        _deposit(tokenB, 1000);
        governor.setFinalized(tokenA, 1, true);
        vault.settle(tokenA, 1);
        assertEq(vault.causePool(tokenB), 900);
    }

    function test_settleTwiceReverts() public {
        governor.setCurrentEpoch(1);
        _deposit(tokenA, 1000);
        governor.setFinalized(tokenA, 1, true);
        vault.settle(tokenA, 1);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.AlreadySettled.selector, tokenA, 1));
        vault.settle(tokenA, 1);
    }

    function test_settleEmptyReverts() public {
        governor.setFinalized(tokenA, 1, true);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.NothingToSettle.selector, tokenA, 1));
        vault.settle(tokenA, 1);
    }

    function test_settleUnregisteredReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.TokenNotRegistered.selector, address(7)));
        vault.settle(address(7), 1);
    }

    function test_settleOnlyThatEpochsFees() public {
        governor.setCurrentEpoch(1);
        _deposit(tokenA, 1000);
        governor.setCurrentEpoch(2);
        _deposit(tokenA, 2000);
        governor.setCurrentEpoch(3);
        _deposit(tokenA, 4000);
        governor.setFinalized(tokenA, 1, true);
        governor.setFinalized(tokenA, 3, true);

        // Settling epoch 1 cannot drag epoch 2 or 3 fees to epoch 1's winner.
        vault.settle(tokenA, 1);
        assertEq(distributor.received(tokenA, 1), 900);
        assertEq(vault.causePoolOf(tokenA, 2), 1800);
        assertEq(vault.causePoolOf(tokenA, 3), 3600);
        assertEq(vault.causePool(tokenA), 5400);

        vault.settle(tokenA, 3);
        assertEq(distributor.received(tokenA, 3), 3600);
        assertEq(distributor.received(tokenA, 1), 900);
        assertEq(vault.causePoolOf(tokenA, 2), 1800);
    }

    function test_cannotSettleCurrentEpochFees() public {
        governor.setCurrentEpoch(2);
        _deposit(tokenA, 1000);
        governor.setFinalized(tokenA, 1, true);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.NothingToSettle.selector, tokenA, 1));
        vault.settle(tokenA, 1);
        assertEq(vault.causePoolOf(tokenA, 2), 900);
    }

    function testFuzz_splitSumsExactly(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        (uint256 p, uint256 c) = vault.split(amount);
        assertEq(p + c, amount);
        assertLe(p, amount / 10);
        assertGe(c, amount - amount / 10);
    }

    function testFuzz_depositConservation(uint96 a, uint96 b) public {
        _deposit(tokenA, a);
        _deposit(tokenB, b);
        assertEq(
            vault.platformAccrued() + vault.causePool(tokenA) + vault.causePool(tokenB),
            uint256(a) + uint256(b)
        );
        assertEq(vault.totalTracked(), uint256(a) + uint256(b));
        assertEq(usdc.balanceOf(address(vault)), vault.totalTracked());
    }
}
