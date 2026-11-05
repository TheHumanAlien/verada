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
///      initial anchor band, frequent small hops, and a deviation guard below ten ticks.
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

    /// The band grows by `maxDriftTicks` per widening period and resets when re-anchored.
    function test_anchorBandWidensWithTimeAndResetsOnReanchor() public {
        uint256 drift = cons.maxDriftTicks();
        assertEq(cons.anchorBandOf(quoteKey), drift);
        vm.warp(t0 + cons.ANCHOR_WIDENING_PERIOD());
        assertEq(cons.anchorBandOf(quoteKey), 2 * drift);
        vm.warp(t0 + 3 * cons.ANCHOR_WIDENING_PERIOD() / 2);
        assertEq(cons.anchorBandOf(quoteKey), drift + (3 * drift) / 2);

        PoolKey[] memory ks = new PoolKey[](1);
        ks[0] = quoteKey;
        cons.seedReferences(ks);
        assertEq(cons.anchorBandOf(quoteKey), drift);

        // A huge drift setting saturates instead of overflowing.
        cons.setMaxDriftTicks(type(uint256).max);
        assertEq(cons.anchorBandOf(quoteKey), cons.MAX_ANCHOR_BAND());
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _moveSpotTo(anchor + 20);
        _deliverQuote(1e15);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(_ref(), anchor + 20);
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
