// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";
import {MockERC20, MockOndoToken} from "./ConsolidatorMocks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";

contract FeeConsolidatorTest is ConsolidatorBase {
    using StateLibrary for *;
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
    }

    /// @dev Spot value of `amount` of the quote asset in USDC at the current quote pool price.
    function _quoteSpotUsdc(uint256 amount) internal view returns (uint256) {
        (uint160 sqrtP,,,) = manager.getSlot0(quoteKey.toId());
        bool quoteIs0 = Currency.unwrap(quoteKey.currency0) == address(quote);
        return quoteIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    // ------------------------------------------------------------------ construction

    function test_constructor_wiring() public view {
        assertEq(cons.settlementAsset(), address(usdc));
        assertEq(cons.maxSlippageBps(), MAX_SLIPPAGE_BPS);
        assertEq(cons.hook(), address(hook));
        assertTrue(cons.isSource(address(hook)));
        assertEq(cons.quoteOf(address(meme)), address(quote));
        assertEq(address(hook.feeConsolidator()), address(cons));
    }

    function test_constructor_rejectsBadInput() public {
        vm.expectRevert(FeeConsolidator.ZeroAddress.selector);
        new FeeConsolidator(
            address(this), manager, _reg(), vault, address(0), MAX_SLIPPAGE_BPS, MAX_DEVIATION_TICKS
        );
        vm.expectRevert(abi.encodeWithSelector(IFeeConsolidator.InvalidSlippage.selector, 2001));
        new FeeConsolidator(
            address(this), manager, _reg(), vault, address(weth), 2001, MAX_DEVIATION_TICKS
        );
    }

    function test_constructor_settlementMustMatchRegistry() public {
        QuoteRegistry alt = new QuoteRegistry(address(this), address(meme), address(weth));
        vm.expectRevert(FeeConsolidator.SettlementMismatch.selector);
        new FeeConsolidator(
            address(this),
            manager,
            IConsolidatorRegistry(address(alt)),
            vault,
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
    }

    function _reg() internal view returns (IConsolidatorRegistry) {
        return IConsolidatorRegistry(address(registry));
    }

    // ------------------------------------------------------------------ happy paths

    function test_quoteSide_swapsToUsdcAndCreditsVault() public {
        uint256 amount = 5e18;
        uint256 spot = _quoteSpotUsdc(amount);
        _deliverQuote(amount);

        uint256 got = usdc.balanceOf(address(vault));
        // 0.3% pool fee plus a little price impact, well inside the guard.
        assertGt(got, (spot * 9900) / 10_000);
        assertLe(got, spot);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(cons.totalHeld(address(quote)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);

        // 10% / 90% on the consolidated amount.
        assertEq(vault.platformAccrued(), (got * 1000) / 10_000);
        assertEq(vault.causePool(address(meme)), got - (got * 1000) / 10_000);
        assertEq(vault.totalTracked(), got);
    }

    function test_tokenSide_twoHopsToUsdc() public {
        skip(1900); // the token pool needs a TWAP history
        uint256 amount = 1000e18;
        _deliver(address(meme), amount);

        assertEq(cons.heldFees(address(meme), address(meme)), 0);
        assertEq(meme.balanceOf(address(cons)), 0);
        assertEq(quote.balanceOf(address(cons)), 0); // intermediate asset never touches the contract
        uint256 got = usdc.balanceOf(address(vault));
        // ~0.001 quote per token, ~100 USDC per quote -> ~100 USDC at spot, minus two fees and impact.
        assertGt(got, 90e6);
        assertLt(got, 101e6);
        assertEq(vault.causePool(address(meme)) + vault.platformAccrued(), got);
    }

    function test_emitsAmountsOnSuccess() public {
        vm.recordLogs();
        _deliverQuote(2e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("FeesConsolidated(address,address,uint256,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic0) {
                (uint256 amountIn, uint256 out) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(amountIn, 2e18);
                assertEq(out, usdc.balanceOf(address(vault)));
                seen = true;
            }
        }
        assertTrue(seen);
    }

    // ------------------------------------------------------------------ authorization & input

    function test_consolidate_onlySources() public {
        quote.mint(address(cons), 1e18);
        vm.expectRevert(IFeeConsolidator.NotAuthorized.selector);
        cons.consolidate(address(meme), address(quote), 1e18);
    }

    function test_consolidate_unknownTokenAndCurrency() public {
        vm.prank(locker);
        vm.expectRevert(abi.encodeWithSelector(FeeConsolidator.UnknownToken.selector, address(7)));
        cons.consolidate(address(7), address(quote), 1);

        vm.prank(locker);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeConsolidator.InvalidCurrency.selector, address(meme), address(usdc)
            )
        );
        cons.consolidate(address(meme), address(usdc), 1);
    }

    function test_consolidate_unbackedReverts() public {
        vm.prank(locker);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeConsolidator.UnbackedDeposit.selector, address(quote), 0, 1e18
            )
        );
        cons.consolidate(address(meme), address(quote), 1e18);
    }

    function test_consolidate_zeroIsNoop() public {
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), 0);
        assertEq(vault.totalTracked(), 0);
    }

    function test_registerPool_onlyHook() public {
        PoolKey memory k = tokenKey;
        vm.expectRevert(IFeeConsolidator.NotAuthorized.selector);
        cons.registerPool(address(meme), k);
    }

    function test_setHook_once() public {
        vm.expectRevert(FeeConsolidator.HookAlreadySet.selector);
        cons.setHook(address(1));
    }

    function test_adminOnlyOwner() public {
        address bob = makeAddr("bob");
        vm.startPrank(bob);
        vm.expectRevert();
        cons.setSource(bob, true);
        vm.expectRevert();
        cons.setMaxSlippageBps(1);
        vm.expectRevert();
        cons.setMaxDeviationTicks(1);
        vm.expectRevert();
        cons.rescueExcess(address(quote), bob);
        PoolKey[] memory ks = new PoolKey[](1);
        ks[0] = quoteKey;
        vm.expectRevert();
        cons.seedReferences(ks);
        vm.expectRevert();
        cons.setReference(quoteKey, 0);
        vm.stopPrank();
    }

    function test_setMaxSlippage_capped() public {
        cons.setMaxSlippageBps(2000);
        assertEq(cons.maxSlippageBps(), 2000);
        vm.expectRevert(abi.encodeWithSelector(IFeeConsolidator.InvalidSlippage.selector, 2001));
        cons.setMaxSlippageBps(2001);
    }

    function test_launchAgainstUnroutableQuoteReverts() public {
        // A quote asset that is allowed but has no route cannot back a pool.
        MockOndoToken q2 = new MockOndoToken("Q2");
        registry.addQuoteAsset(address(q2), IQuoteRegistry.Kind.Ondo);
        MockERC20 meme2 = new MockERC20("M2", 18);
        hook.configureToken(address(meme2), _cfgDefault());
        (Currency a, Currency b) = _sorted(address(meme2), address(q2));
        PoolKey memory k = PoolKey(a, b, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------ failures and retry

    function test_pausedOndoHoldsAndRetries() public {
        quote.mint(address(cons), 3e18);
        quote.setPaused(true);
        vm.recordLogs();
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), 3e18); // must not revert
        (, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);

        assertEq(cons.heldFees(address(meme), address(quote)), 3e18);
        assertEq(quote.balanceOf(address(cons)), 3e18);
        assertEq(vault.totalTracked(), 0);

        // Still paused: a manual retry surfaces the reason and keeps the balance.
        vm.expectRevert(MockOndoToken.TokenPaused.selector);
        cons.retry(address(meme), address(quote));
        assertEq(cons.heldFees(address(meme), address(quote)), 3e18);

        quote.setPaused(false);
        uint256 out = cons.retry(address(meme), address(quote)); // anyone
        assertGt(out, 0);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(usdc.balanceOf(address(vault)), out);
    }

    function test_nonCompliantPoolManagerHolds() public {
        quote.setBlocked(address(manager), true);
        _deliverQuote(1e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);
        quote.setBlocked(address(manager), false);
        assertGt(cons.retry(address(meme), address(quote)), 0);
    }

    function test_failureEmitsReasonAndAccumulates() public {
        quote.setPaused(true);
        _deliverQuote(1e18);
        _deliverQuote(2e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 3e18);
        assertEq(cons.totalHeld(address(quote)), 3e18);
        quote.setPaused(false);
        // The next delivery also flushes the previously held amount.
        _deliverQuote(1e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    function test_retryNothingHeldReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IFeeConsolidator.NothingToConsolidate.selector, address(meme), address(quote)
            )
        );
        cons.retry(address(meme), address(quote));
    }

    function test_retryAmountPartial() public {
        quote.setPaused(true);
        _deliverQuote(4e18);
        quote.setPaused(false);

        vm.expectRevert(
            abi.encodeWithSelector(FeeConsolidator.AmountExceedsHeld.selector, 5e18, 4e18)
        );
        cons.retryAmount(address(meme), address(quote), 5e18);

        cons.retryAmount(address(meme), address(quote), 1e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 3e18);
        cons.retry(address(meme), address(quote));
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
    }

    // ------------------------------------------------------------------ price guards

    function test_priceDeviationFailsClosed() public {
        // Push the quote/USDC price far from its reference with a large swap.
        bool quoteIs0 = Currency.unwrap(quoteKey.currency0) == address(quote);
        swap(quoteKey, quoteIs0, -int256(1.5e23), ZERO_BYTES); // sell lots of quote
        int24 moved = _spotTick(quoteKey);
        int24 ref = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        assertGt(_abs(int256(moved) - int256(ref)), int256(MAX_DEVIATION_TICKS));

        vm.recordLogs();
        _deliverQuote(1e18);
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(sel, FeeConsolidator.PriceDeviation.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);

        // Owner re-anchors after judging the move legitimate; then it consolidates.
        PoolKey[] memory ks = new PoolKey[](1);
        ks[0] = quoteKey;
        cons.seedReferences(ks);
        assertGt(cons.retry(address(meme), address(quote)), 0);
    }

    function test_referenceDriftStaysInsideMovingAnchorBand() public {
        (,, bool set, int24 anchor0) = _refTick(quoteKey);
        assertTrue(set);
        uint256 drift = cons.maxDriftTicks();
        assertEq(drift, MAX_DEVIATION_TICKS / 2);
        uint256 t0 = vm.getBlockTimestamp();

        // Park spot inside the deviation guard but far from the anchor.
        bool quoteIs0 = Currency.unwrap(quoteKey.currency0) == address(quote);
        uint256 guard;
        while (
            _abs(int256(_spotTick(quoteKey)) - int256(anchor0)) < int256(MAX_DEVIATION_TICKS) - 150
        ) {
            swap(quoteKey, quoteIs0, -int256(5e21), ZERO_BYTES);
            if (++guard > 200) revert("price did not move");
        }
        int24 spot = _spotTick(quoteKey);
        assertLe(_abs(int256(spot) - int256(anchor0)), int256(MAX_DEVIATION_TICKS));

        // A tiny successful hop once a day: the reference follows spot by at most a tenth of the
        // deviation guard per hop and stays within `maxDriftTicks` of the anchor, which itself
        // moves by at most `maxDriftTicks` per anchor period.
        int24 prev = anchor0;
        int24 prevAnchor = anchor0;
        uint256 perDay = (drift * 1 days) / cons.ANCHOR_PERIOD();
        for (uint256 i = 1; i <= 40; ++i) {
            vm.warp(t0 + i * 1 days);
            _deliverQuote(1e12);
            (int24 t,,, int24 a) = _refTick(quoteKey);
            assertLe(_abs(int256(t) - int256(a)), int256(drift), "outside anchor band");
            assertLe(_abs(int256(a) - int256(prevAnchor)), int256(perDay), "anchor rate");
            assertLe(_abs(int256(t) - int256(prev)), int256(MAX_DEVIATION_TICKS / 10), "step");
            prev = t;
            prevAnchor = a;
        }
        // A level held for weeks is eventually followed (within the sub-tick rounding).
        assertLe(_abs(int256(prev) - int256(_spotTick(quoteKey))), 1, "follows a held level");

        // Owner can pin the reference to the anchor or re-anchor explicitly.
        cons.setMaxDriftTicks(0);
        assertEq(cons.maxDriftTicks(), 0);
        vm.warp(t0 + 41 days);
        _deliverQuote(1e12);
        (int24 pinned,,, int24 anchorNow) = _refTick(quoteKey);
        assertEq(pinned, anchorNow, "zero drift pins the reference");
    }

    function test_deviationSetterKeepsDriftConsistent() public {
        cons.setMaxDeviationTicks(3000);
        assertEq(cons.maxDriftTicks(), 1500);
        cons.setMaxDriftTicks(3000);
        vm.expectRevert(abi.encodeWithSelector(FeeConsolidator.InvalidDrift.selector, 3001));
        cons.setMaxDriftTicks(3001);
        // Lowering the guard brings the drift band down with it.
        cons.setMaxDeviationTicks(100);
        assertEq(cons.maxDriftTicks(), 50);
        uint256 span = cons.MAX_TICK_SPAN();
        vm.expectRevert(abi.encodeWithSelector(FeeConsolidator.InvalidDeviation.selector, span + 1));
        cons.setMaxDeviationTicks(span + 1);
    }

    function _refTick(PoolKey memory k) internal view returns (int24 t, uint40 u, bool s, int24 a) {
        (t, u, s, a,) = cons.references(k.toId());
    }

    function test_referenceNotSetFailsClosed() public {
        // A fresh fixture whose route pool was never seeded with a reference.
        _baseSetUp();
        (Currency q0, Currency q1) = _sorted(address(quote), address(usdc));
        quoteKey = PoolKey(q0, q1, 3000, 60, IHooks(address(0)));
        int24 qt = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        manager.initialize(quoteKey, TickMath.getSqrtPriceAtTick(qt));
        _addLiquidity(quoteKey, qt, 2e19);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = quoteKey;
        registry.addQuoteAssetWithRoute(address(quote), IQuoteRegistry.Kind.Ondo, route);
        hook.configureToken(address(meme), _cfgDefault());
        (Currency t0, Currency t1) = _sorted(address(meme), address(quote));
        tokenKey = PoolKey(t0, t1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        manager.initialize(
            tokenKey,
            TickMath.getSqrtPriceAtTick(_orientedTick(address(meme), address(quote), TOKEN_TICK))
        );

        vm.recordLogs();
        _deliverQuote(1e18);
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(sel, FeeConsolidator.ReferenceNotSet.selector);
    }

    function test_tokenSide_needsTwapHistory() public {
        vm.recordLogs();
        _deliver(address(meme), 100e18); // pool is seconds old
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(sel, FeeConsolidator.OracleUnavailable.selector);
        assertEq(cons.heldFees(address(meme), address(meme)), 100e18);

        skip(1900);
        assertGt(cons.retry(address(meme), address(meme)), 0);
    }

    function test_tokenSide_twapGuardBlocksManipulation() public {
        skip(2000);
        swap(
            tokenKey,
            Currency.unwrap(tokenKey.currency0) == address(meme),
            -int256(2e24),
            ZERO_BYTES
        );
        // Spot moved a lot but the TWAP did not (no time has passed).
        vm.recordLogs();
        _deliver(address(meme), 100e18);
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(sel, FeeConsolidator.PriceDeviation.selector);
        assertEq(cons.heldFees(address(meme), address(meme)), 100e18);
    }

    function test_slippageGuardFailsClosedThenPartialRetry() public {
        // Loosen the deviation bound so only the slippage guard can trip.
        cons.setMaxDeviationTicks(5000);
        // An amount whose impact exceeds the 3% tolerance on top of the 0.3% fee.
        uint256 big = 1.2e23;
        quote.mint(address(cons), big);
        vm.recordLogs();
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), big);
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(sel, IFeeConsolidator.SlippageTooHigh.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), big);

        // Draining in smaller pieces works.
        uint256 piece = 5e21;
        while (cons.heldFees(address(meme), address(quote)) >= piece) {
            try cons.retryAmount(address(meme), address(quote), piece) {}
            catch {
                break;
            }
        }
        assertLt(cons.heldFees(address(meme), address(quote)), big);
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------------ hook interplay

    function test_hookSurchargeIsHeldThenRetried() public {
        _baseSetUp();
        _setupPools(5000, 1 days);
        skip(2000); // TWAP history exists, surcharge still active
        uint256 surchargeBefore = hook.currentFeeBps(address(meme));
        assertGt(surchargeBefore, BASE_BPS);

        bool memeIs0 = Currency.unwrap(tokenKey.currency0) == address(meme);
        vm.recordLogs();
        swap(tokenKey, memeIs0, -int256(100e18), ZERO_BYTES);
        (bytes4 sel, bool found) = _lastFailure(vm.getRecordedLogs());
        // The swap happens inside an unlock: the amount is held, never swapped from the hook.
        assertTrue(found);
        assertEq(sel, FeeConsolidator.PoolManagerBusy.selector);

        // Surcharge is taken on the unspecified currency (the quote for an exact-input sell).
        uint256 held = cons.heldFees(address(meme), address(quote));
        assertGt(held, 0);
        assertEq(quote.balanceOf(address(cons)), held);

        uint256 out = cons.retry(address(meme), address(quote));
        assertGt(out, 0);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(usdc.balanceOf(address(vault)), out);
    }

    function test_consolidatorSwapsPaySurchargeNever() public {
        _baseSetUp();
        _setupPools(8000, 1 days);
        skip(2000);
        uint256 amount = 500e18;
        _deliver(address(meme), amount);
        // The route swapped the token side through the hooked pool in a sniper window; the hook
        // must not have taken a surcharge (which would be re-delivered into the consolidator).
        assertEq(cons.heldFees(address(meme), address(meme)), 0);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(meme.balanceOf(address(cons)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------------ rescue

    function test_rescueExcessOnlyUnowed() public {
        _deliverQuote(1e18);
        quote.setPaused(true);
        _deliverQuote(2e18); // held
        quote.setPaused(false);
        quote.mint(address(cons), 5);
        address to = makeAddr("rescue");
        cons.rescueExcess(address(quote), to);
        assertEq(quote.balanceOf(to), 5);
        assertEq(quote.balanceOf(address(cons)), 2e18); // owed balance untouched
        vm.expectRevert(
            abi.encodeWithSelector(FeeConsolidator.NothingToRescue.selector, address(quote))
        );
        cons.rescueExcess(address(quote), to);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_quoteSideConservesValue(uint96 amountSeed) public {
        uint256 amount = bound(amountSeed, 1e12, 3e20);
        _deliverQuote(amount);
        uint256 held = cons.heldFees(address(meme), address(quote));
        if (held == 0) {
            assertEq(quote.balanceOf(address(cons)), 0);
            assertEq(vault.totalTracked(), usdc.balanceOf(address(vault)));
            uint256 out = usdc.balanceOf(address(vault));
            // Never below the guard and never above spot.
            assertLe(out, _quoteSpotUsdcAtStart(amount));
        } else {
            // Failure is only ever a hold, not a loss.
            assertEq(held, amount);
            assertEq(quote.balanceOf(address(cons)), amount);
            assertEq(usdc.balanceOf(address(vault)), 0);
        }
    }

    function _quoteSpotUsdcAtStart(uint256 amount) internal view returns (uint256) {
        // Spot moves slightly against the swapper, so the post-swap spot is a safe upper bound
        // on nothing; use the reference tick price instead.
        int24 ref = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(ref);
        bool quoteIs0 = Currency.unwrap(quoteKey.currency0) == address(quote);
        return quoteIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }

    function _cfgDefault() internal view returns (IVeradaHook.FeeConfig memory) {
        return IVeradaHook.FeeConfig({
            baseFeeBps: BASE_BPS,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            launchTimestamp: uint40(block.timestamp)
        });
    }
}
