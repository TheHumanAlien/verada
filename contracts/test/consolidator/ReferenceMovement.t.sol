// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {ConsolidatorBase} from "./ConsolidatorBase.sol";

/// @dev How the moving reference of a route pool follows the market: a sustained trend past the
///      initial anchor band, a bounded anchor rate that cannot be banked by a quiet pool and
///      spent in a burst, frequent small hops, and a deviation guard below ten ticks.
contract ReferenceMovementTest is ConsolidatorBase {
    using StateLibrary for *;
    using PoolIdLibrary for PoolKey;

    int24 internal anchor;
    uint256 internal t0;

    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
        (,,, anchor,) = cons.references(quoteKey.toId());
        t0 = vm.getBlockTimestamp();
    }

    /// @dev Moves the quote pool spot inside tick `target` (between it and the next tick).
    function _moveSpotTo(int24 target) internal {
        (uint160 current,,,) = manager.getSlot0(quoteKey.toId());
        uint160 lo = TickMath.getSqrtPriceAtTick(target);
        uint160 hi = TickMath.getSqrtPriceAtTick(target + 1);
        uint160 limit = lo + (hi - lo) / 2;
        if (limit == current) return;
        bool zeroForOne = limit < current;
        swapRouter.swap(
            quoteKey,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -1e30, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        assertEq(_spotTick(quoteKey), target, "spot placed");
    }

    function _ref() internal view returns (int24 tick) {
        (tick,,,,) = cons.references(quoteKey.toId());
    }

    function _anchor() internal view returns (int24 a) {
        (,,, a,) = cons.references(quoteKey.toId());
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x < 0 ? -x : x);
    }

    /// A market that trends 100 ticks a day for 20 days ends 2000 ticks from the anchor, beyond
    /// the initial band plus the deviation guard (500 + 1000). Each daily hop must still settle.
    function test_referenceFollowsSustainedTrendPastAnchorBand() public {
        assertEq(cons.maxDriftTicks() + cons.maxDeviationTicks(), 1500);
        for (uint256 day = 1; day <= 20; ++day) {
            vm.warp(t0 + day * 1 days);
            _moveSpotTo(anchor + int24(int256(day * 100)));
            _deliverQuote(1e15);
            assertEq(cons.heldFees(address(meme), address(quote)), 0, "hop failed");
        }
        assertGt(int256(_spotTick(quoteKey)) - int256(anchor), 1500);
        assertGt(int256(_ref()) - int256(anchor), 500, "reference left the initial band");
    }

    /// A slower trend held for twelve weeks (60 ticks a day, under the anchor rate of
    /// `maxDriftTicks` per period) is followed without the owner, ending far outside where the
    /// guard and the initial band would allow (5040 ticks against 1500).
    function test_slowTrendStaysLiveForMonths() public {
        uint256 drift = cons.maxDriftTicks();
        assertLt(60 * 7, drift, "trend below the anchor rate");
        for (uint256 day = 1; day <= 84; ++day) {
            vm.warp(t0 + day * 1 days);
            _moveSpotTo(anchor + int24(int256(day * 60)));
            _deliverQuote(1e15);
            assertEq(cons.heldFees(address(meme), address(quote)), 0, "hop failed");
        }
        assertGt(int256(_ref()) - int256(anchor), 4000, "reference followed the trend");
        assertLe(_abs(int256(_ref()) - int256(_anchor())), drift, "reference inside the band");
    }

    /// Regression: the band used to widen with the time since the anchor was set, so a pool
    /// left quiet for ten weeks had built up 5500 ticks of band that a burst of manipulated hops
    /// could spend (2971 ticks in 72 hours, while the fair price never moved). Now the anchor
    /// itself moves at most `maxDriftTicks` per period with at most one period counted, so the
    /// same burst moves the reference at most `2 * drift + drift * 72h / period`.
    function test_quietPoolCannotBeWalkedInABurst() public {
        int24 fair = anchor;
        uint256 drift = cons.maxDriftTicks();
        uint256 dev = cons.maxDeviationTicks();
        // Fees held for later retries (the route was down when they arrived).
        quote.setPaused(true);
        _deliverQuote(1e18);
        quote.setPaused(false);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);

        vm.warp(t0 + 10 weeks); // quiet: nothing hops
        uint256 start = vm.getBlockTimestamp();
        uint256 period = cons.ANCHOR_PERIOD();
        for (uint256 i = 1; i <= 30; ++i) {
            vm.warp(start + i * 2.4 hours);
            // Push spot to the edge of the guard, retry a little (permissionless), swap back.
            _moveSpotTo(_ref() + int24(int256(dev)));
            vm.prank(makeAddr("attacker"));
            cons.retryAmount(address(meme), address(quote), 1e15);
            _moveSpotTo(fair);
            uint256 bound = 2 * drift + (drift * (i * 2.4 hours)) / period;
            assertLe(_abs(int256(_ref()) - int256(fair)), bound, "reference walked too far");
        }
        uint256 walked = _abs(int256(_ref()) - int256(fair));
        assertLe(walked, 2 * drift + (drift * 72 hours) / period);
        assertLt(walked, 2971, "less than the old burst");

        // The worst spot a full retry can now clear is `walked + dev` from fair, not 3970.
        _moveSpotTo(fair + 3970);
        vm.expectRevert();
        cons.retry(address(meme), address(quote));
        assertLe(walked + dev, 2 * drift + dev + (drift * 72 hours) / period);
    }

    /// The anchor moves toward the reference at no more than `maxDriftTicks` per period, quiet
    /// time beyond one period does not add to that, and re-anchoring resets it.
    function test_anchorMovesAtBoundedRateAndResetsOnReanchor() public {
        uint256 drift = cons.maxDriftTicks();
        uint256 period = cons.ANCHOR_PERIOD();
        _moveSpotTo(anchor + 400);
        // Daily hops: the reference walks toward spot, the anchor follows at drift / period.
        int24 prevAnchor = anchor;
        for (uint256 day = 1; day <= 10; ++day) {
            vm.warp(t0 + day * 1 days);
            _deliverQuote(1e12);
            assertLe(_abs(int256(_anchor()) - int256(prevAnchor)), (drift * 1 days) / period);
            prevAnchor = _anchor();
        }
        assertGt(int256(_anchor()) - int256(anchor), 0, "anchor followed");

        // Long quiet time counts as one period at most.
        _moveSpotTo(_ref() + 600);
        vm.warp(t0 + 30 weeks);
        int24 before = _anchor();
        _deliverQuote(1e12);
        assertLe(_abs(int256(_anchor()) - int256(before)), drift, "one period at most");

        PoolKey[] memory ks = new PoolKey[](1);
        ks[0] = quoteKey;
        cons.seedReferences(ks);
        assertEq(_anchor(), _spotTick(quoteKey));
        assertEq(_ref(), _spotTick(quoteKey));
    }

    /// Hops every five minutes against a spot 200 ticks away: each step alone rounds to zero
    /// (200 * 300 / 86400), but the elapsed time must still add up and move the reference.
    function test_frequentHopsStillMoveReference() public {
        _moveSpotTo(anchor + 200);
        for (uint256 i = 1; i <= 288; ++i) {
            vm.warp(t0 + i * 5 minutes);
            _deliverQuote(1e12);
            assertEq(cons.heldFees(address(meme), address(quote)), 0);
        }
        int256 moved = int256(_ref()) - int256(anchor);
        assertGe(moved, 50, "reference frozen by frequent hops");
        assertLe(moved, 200);
    }

    /// A hop at spot equal to the reference consumes the elapsed time: the next hop does not
    /// move further than the time since then allows.
    function test_hopAtReferenceResetsElapsedTime() public {
        vm.warp(t0 + 1 days);
        _deliverQuote(1e12); // spot == reference: nothing to move, the timer restarts
        (, uint40 updatedAt,,,) = cons.references(quoteKey.toId());
        assertEq(updatedAt, t0 + 1 days);
        int24 before = _ref();
        _moveSpotTo(before + 50);
        vm.warp(t0 + 1 days + 1 hours);
        _deliverQuote(1e12);
        // 50 * 3600 / 86400 = 2 ticks, not the 50 a full day would give.
        assertEq(int256(_ref()) - int256(before), 2);
    }

    /// With a deviation guard below ten ticks the per-hop cap used to round to zero, which froze
    /// the reference for good. It now moves at least one tick.
    function test_smallDeviationGuardStillMovesReference() public {
        cons.setMaxDeviationTicks(5);
        _moveSpotTo(anchor + 3);
        vm.warp(t0 + 1 days);
        _deliverQuote(1e12);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(int256(_ref()) - int256(anchor), 1, "reference frozen by a zero cap");
    }
}
