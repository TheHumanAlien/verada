// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";

import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";

import {ConsolidatorBase} from "./ConsolidatorBase.sol";

/// @dev Fees reach the cause pool of the epoch in which they were earned, whoever triggers the
///      swap and whenever: held fees keep their accrual epoch through a retry, a flush by a later
///      delivery and a partial retry; LP fees spread over the epochs of their accrual interval.
contract FeeEpochAttributionTest is ConsolidatorBase {
    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
    }

    function _causeOf(uint256 out) internal view returns (uint256 cause) {
        (, cause) = vault.split(out);
    }

    /// A route that fails in epoch 1 and is retried in epoch 3 still pays epoch 1.
    function test_retriedFeesGoToTheirAccrualEpoch() public {
        governor.setCurrentEpoch(1);
        quote.setPaused(true);
        _deliverQuote(1e18);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 1), 1e18);

        governor.setCurrentEpoch(3);
        quote.setPaused(false);
        uint256 out = cons.retry(address(meme), address(quote)); // any caller, any time
        assertGt(out, 0);
        assertEq(vault.causePoolOf(address(meme), 1), _causeOf(out), "accrual epoch paid");
        assertEq(vault.causePoolOf(address(meme), 3), 0, "retry epoch must not be paid");
        assertEq(cons.heldFeesIn(address(meme), address(quote), 1), 0);
    }

    /// A later delivery flushes held fees in the same swap; each epoch gets its input share.
    function test_flushSplitsOutputByAccrualEpoch() public {
        governor.setCurrentEpoch(1);
        quote.setPaused(true);
        _deliverQuote(1e18);
        governor.setCurrentEpoch(2);
        quote.setPaused(false);

        uint256 before = usdc.balanceOf(address(vault));
        _deliverQuote(3e18); // swaps all 4e18 at once
        uint256 out = usdc.balanceOf(address(vault)) - before;
        assertEq(cons.heldFees(address(meme), address(quote)), 0);

        uint256 first = FullMath.mulDiv(out, 1e18, 4e18);
        assertEq(vault.causePoolOf(address(meme), 1), _causeOf(first));
        assertEq(vault.causePoolOf(address(meme), 2), _causeOf(out - first));
        assertEq(
            vault.causePoolOf(address(meme), 1) + vault.causePoolOf(address(meme), 2),
            vault.causePool(address(meme))
        );
    }

    /// A partial retry spends the oldest accrual epoch first.
    function test_partialRetrySpendsOldestEpochFirst() public {
        quote.setPaused(true);
        governor.setCurrentEpoch(1);
        _deliverQuote(1e18);
        governor.setCurrentEpoch(2);
        _deliverQuote(3e18);
        governor.setCurrentEpoch(3);
        quote.setPaused(false);

        uint256 out = cons.retryAmount(address(meme), address(quote), 2e18);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 1), 0);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 2), 2e18);
        uint256 half = FullMath.mulDiv(out, 1e18, 2e18);
        assertEq(vault.causePoolOf(address(meme), 1), _causeOf(half));
        assertEq(vault.causePoolOf(address(meme), 2), _causeOf(out - half));
        assertEq(vault.causePoolOf(address(meme), 3), 0);

        cons.retry(address(meme), address(quote));
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 2), 0);
        assertEq(vault.causePoolOf(address(meme), 3), 0);
    }

    /// While the route stays broken, settling waits out the grace period; after it, fees of the
    /// settled epoch go to the first unsettled epoch after it, not to the epoch in which the
    /// caller chose to retry.
    function test_lateFeesOfSettledEpochGoToNextUnsettledEpoch() public {
        governor.setCurrentEpoch(1);
        _deliverQuote(1e18); // consolidated into epoch 1
        quote.setPaused(true);
        _deliverQuote(2e18); // held, earned in epoch 1

        governor.setCurrentEpoch(4);
        governor.setFinalized(address(meme), 1, true);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FeesPending.selector, address(meme), 1));
        vault.settle(address(meme), 1);

        vm.warp(governor.epochStart(2) + vault.SETTLE_GRACE());
        vault.settle(address(meme), 1);
        assertEq(vault.causePoolOf(address(meme), 1), 0);

        quote.setPaused(false);
        uint256 out = cons.retry(address(meme), address(quote));
        assertEq(vault.causePoolOf(address(meme), 1), 0, "settled epoch takes nothing");
        assertEq(vault.causePoolOf(address(meme), 2), _causeOf(out), "next unsettled epoch");
        assertEq(vault.causePoolOf(address(meme), 4), 0, "caller's epoch takes nothing");
    }

    /// LP fees earned over an interval that spans an epoch boundary are split by time.
    function test_accruedFeesSpreadOverEpochsByTime() public {
        uint256 nowTs = 100 days;
        vm.warp(nowTs);
        // Epoch 0 = [now - 10 days, now - 3 days), epoch 1 = [now - 3 days, now + 4 days).
        governor.useClock(nowTs - 10 days);
        assertEq(governor.currentEpoch(), 1);

        quote.setPaused(true);
        quote.mint(address(cons), 2e18);
        vm.prank(locker);
        cons.consolidateAccrued(address(meme), address(quote), 2e18, nowTs - 6 days);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 0), 1e18);
        assertEq(cons.heldFeesIn(address(meme), address(quote), 1), 1e18);

        // Collected two epochs later: the swap still pays epochs 0 and 1, never epoch 3.
        vm.warp(nowTs + 15 days);
        assertEq(governor.currentEpoch(), 3);
        quote.setPaused(false);
        uint256 out = cons.retry(address(meme), address(quote));
        uint256 half = FullMath.mulDiv(out, 1e18, 2e18);
        assertEq(vault.causePoolOf(address(meme), 0), _causeOf(half));
        assertEq(vault.causePoolOf(address(meme), 1), _causeOf(out - half));
        assertEq(vault.causePoolOf(address(meme), 3), 0);
    }

    /// An accrual interval longer than `MAX_ACCRUAL_EPOCHS` is clamped to the newest of them;
    /// nothing is lost and no epoch outside them is tagged.
    function test_accruedFeesClampToMaxEpochs() public {
        uint256 epochs = cons.MAX_ACCRUAL_EPOCHS();
        vm.warp(400 days);
        governor.useClock(0);
        uint256 current = governor.currentEpoch();
        assertGt(current, epochs);

        quote.setPaused(true);
        uint256 amount = 1e18 + 7;
        quote.mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidateAccrued(address(meme), address(quote), amount, 0);

        uint256 sum;
        for (uint256 e; e <= current; ++e) {
            uint256 part = cons.heldFeesIn(address(meme), address(quote), e);
            if (e + epochs <= current) assertEq(part, 0, "older than the window");
            sum += part;
        }
        assertEq(sum, amount);
        assertEq(cons.heldFees(address(meme), address(quote)), amount);
    }

    /// An interval that starts now (or later) is attributed to the current epoch.
    function test_accruedFeesWithoutIntervalUseCurrentEpoch() public {
        governor.setCurrentEpoch(2);
        quote.setPaused(true);
        quote.mint(address(cons), 5e17);
        vm.prank(locker);
        cons.consolidateAccrued(
            address(meme), address(quote), 5e17, vm.getBlockTimestamp() + 1 days
        );
        assertEq(cons.heldFeesIn(address(meme), address(quote), 2), 5e17);
    }
}
