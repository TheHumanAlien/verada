// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {MockPositionManager} from "../vault/VaultMocks.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";

/// @dev Settling an epoch cannot move fees earned in it to a later epoch: whether a keeper
///      flushes or collects first, or someone settles first (even in the transaction that
///      finalizes the epoch), the epoch's winner receives the same amount.
contract SettleOrderingTest is ConsolidatorBase {
    uint256 internal launch;
    bool internal memeIn0;

    function setUp() public {
        vm.warp(30 days);
        _baseSetUp();
        _setupPools(500, 1 days);
        launch = vm.getBlockTimestamp();
        memeIn0 = address(meme) < address(quote);
        // Epoch 1 ends one hour after launch, inside the sniper window.
        governor.useClock(launch + 1 hours - 14 days);
        assertEq(governor.currentEpoch(), 1);
    }

    /// @dev A surcharged swap: the hook holds the surcharge (in the quote asset) untouched,
    ///      tagged with the current epoch, because it cannot swap inside the pool manager.
    function _surchargedSwap() internal {
        swapRouter.swap(
            tokenKey,
            SwapParams({
                zeroForOne: memeIn0,
                amountSpecified: -1e21,
                sqrtPriceLimitX96: memeIn0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// Regression: hook fees held from epoch 1 used to go to epoch 2's winner when anyone
    /// settled epoch 1 before a retry. Both orderings now pay epoch 1 the same.
    function test_settleBeforeRetryStillPaysTheEpoch() public {
        vm.warp(launch + 10 minutes);
        _surchargedSwap();
        uint256 held1 = cons.heldFeesIn(address(meme), address(quote), 1);
        assertGt(held1, 0, "epoch 1 fees held");

        vm.warp(launch + 2 hours); // epoch 2
        _surchargedSwap();
        assertGt(cons.heldFeesIn(address(meme), address(quote), 2), 0, "epoch 2 fees held");
        governor.setFinalized(address(meme), 1, true);

        uint256 snap = vm.snapshotState();
        // Ordering A: a keeper retries, then the epoch is settled.
        cons.retry(address(meme), address(quote));
        vault.settle(address(meme), 1);
        uint256 paidA = distributor.received(address(meme), 1);
        uint256 nextA = vault.causePoolOf(address(meme), 2);

        vm.revertToState(snap);
        // Ordering B: someone settles first (as if in the transaction that finalized it).
        vm.prank(makeAddr("settler"));
        vault.settle(address(meme), 1);
        uint256 paidB = distributor.received(address(meme), 1);
        uint256 nextB = vault.causePoolOf(address(meme), 2);

        assertGt(paidA, 0);
        assertEq(paidB, paidA, "epoch 1 paid the same whoever goes first");
        assertEq(nextB, nextA, "epoch 2 keeps only its own fees");
        assertEq(cons.heldFees(address(meme), address(quote)), 0, "settle flushed");
    }

    /// The same for LP fees: settling collects the locker first, so epoch 1 keeps its time
    /// share of fees earned across the boundary instead of losing it to epoch 2.
    function test_settleBeforeLpCollectionStillPaysTheEpoch() public {
        MockPositionManager pm = new MockPositionManager(address(meme), address(quote));
        VeradaLpLocker lpLocker =
            new VeradaLpLocker(address(pm), IFeeConsolidator(address(cons)), address(this));
        cons.setSource(address(lpLocker), true);
        vault.setLpLocker(ILpLocker(address(lpLocker)));
        uint256 id = pm.mintTo(address(lpLocker), 1e18);
        lpLocker.lock(address(meme), id);

        // Quote fees accrue across the boundary: half the interval in epoch 1, half in 2.
        vm.warp(launch + 2 hours);
        quote.mint(address(pm), 4e18);
        pm.accrue(id, 0, 4e18);
        governor.setFinalized(address(meme), 1, true);

        uint256 snap = vm.snapshotState();
        lpLocker.collectFees(address(meme));
        vault.settle(address(meme), 1);
        uint256 paidA = distributor.received(address(meme), 1);
        uint256 nextA = vault.causePoolOf(address(meme), 2);

        vm.revertToState(snap);
        vault.settle(address(meme), 1);
        uint256 paidB = distributor.received(address(meme), 1);
        uint256 nextB = vault.causePoolOf(address(meme), 2);

        assertGt(paidA, 0);
        assertEq(paidB, paidA, "epoch 1 paid the same whoever goes first");
        assertEq(nextB, nextA);
        assertApproxEqRel(nextB, paidB, 0.01e18, "split by time");
        assertEq(lpLocker.lastCollectedAt(address(meme)), launch + 2 hours);
    }

    /// While held fees of the epoch cannot be swapped, settling reverts (until the grace
    /// period), so a settler cannot skip them by settling while the route is down or from
    /// inside a pool manager unlock.
    function test_settleWaitsForHeldFeesItCannotFlush() public {
        vm.warp(launch + 10 minutes);
        _surchargedSwap();
        vm.warp(launch + 2 hours);
        governor.setFinalized(address(meme), 1, true);

        quote.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FeesPending.selector, address(meme), 1));
        vault.settle(address(meme), 1);

        // Back up: anyone can settle and the epoch gets its fees.
        quote.setPaused(false);
        vault.settle(address(meme), 1);
        assertGt(distributor.received(address(meme), 1), 0);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
    }

    /// `flushThrough` is permissionless, reports what is left and ignores newer-only holdings.
    function test_flushThroughReportsWhatIsLeft() public {
        vm.warp(launch + 2 hours); // epoch 2
        _surchargedSwap();
        assertFalse(cons.heldThrough(address(meme), address(quote), 1), "only epoch 2 held");
        assertTrue(cons.heldThrough(address(meme), address(quote), 2));
        // Nothing of epoch 1 is held, so nothing is swapped.
        assertTrue(cons.flushThrough(address(meme), 1));
        assertGt(cons.heldFees(address(meme), address(quote)), 0);

        quote.setPaused(true);
        assertFalse(cons.flushThrough(address(meme), 2), "route down");
        quote.setPaused(false);
        assertTrue(cons.flushThrough(address(meme), 2));
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
    }

    /// Dust that rounds to zero output does not block settlement: it is consumed.
    function test_dustHeldDoesNotBlockSettle() public {
        _deliverQuote(1e18); // consolidated into epoch 1
        quote.setPaused(true);
        _deliverQuote(1); // one wei held for epoch 1
        quote.setPaused(false);
        vm.warp(launch + 2 hours);
        governor.setFinalized(address(meme), 1, true);
        vault.settle(address(meme), 1);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(cons.totalHeld(address(quote)), 0);
    }
}
