// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../script/HookMiner.sol";
import {VeradaHook} from "../src/VeradaHook.sol";
import {IVeradaHook} from "../src/interfaces/IVeradaHook.sol";
import {MockConsolidator} from "./utils/MockConsolidator.sol";

/// @dev Runs the hook against the real v4 PoolManager. Currency1 plays WETH, currency0 the token.
contract VeradaHookTest is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MockConsolidator internal vault;
    VeradaHook internal hook;
    address internal token;
    address internal weth;

    PoolKey internal hookKey;
    PoolKey internal refKey;

    uint24 internal constant BASE_BPS = 300;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        token = Currency.unwrap(currency0);
        weth = Currency.unwrap(currency1);
        vault = new MockConsolidator();
        hook = _deployHook(vault);
        vault.setHook(address(hook));
    }

    // ------------------------------------------------------------------ helpers

    function _deployHook(MockConsolidator c) internal returns (VeradaHook h) {
        bytes memory args = abi.encode(manager, address(this), address(c));
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(VeradaHook).creationCode, args);
        h = new VeradaHook{salt: salt}(manager, address(this), address(c));
        assertEq(address(h), predicted);
    }

    function _cfg(uint24 base, uint24 sniper, uint32 decay)
        internal
        view
        returns (IVeradaHook.FeeConfig memory)
    {
        return IVeradaHook.FeeConfig({
            baseFeeBps: base,
            sniperFeeStartBps: sniper,
            sniperDecaySeconds: decay,
            launchTimestamp: uint40(block.timestamp)
        });
    }

    function _liquidity() internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({
            tickLower: -6000, tickUpper: 6000, liquidityDelta: 1_000_000e18, salt: 0
        });
    }

    /// @dev Sets up the hooked pool plus a hook-less reference pool with the same static fee.
    function _setupPools(uint24 base, uint24 sniper, uint32 decay) internal {
        hook.configureToken(token, _cfg(base, sniper, decay));
        (hookKey,) = initPool(
            currency0,
            currency1,
            IHooks(address(hook)),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            SQRT_PRICE_1_1
        );
        (refKey,) = initPool(
            currency0, currency1, IHooks(address(0)), uint24(base) * 100, 60, SQRT_PRICE_1_1
        );
        modifyLiquidityRouter.modifyLiquidity(hookKey, _liquidity(), ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(refKey, _liquidity(), ZERO_BYTES);
    }

    function _bal(address t) internal view returns (uint256) {
        return IERC20(t).balanceOf(address(this));
    }

    function _ceilBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps + 9999) / 10_000;
    }

    // ------------------------------------------------------------------ permissions

    function test_addressEncodesExactFlags() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS);
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeSwap && p.afterSwap && p.afterSwapReturnDelta);
        assertFalse(p.afterInitialize || p.beforeAddLiquidity || p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity || p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate || p.afterDonate || p.beforeSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta);
    }

    function test_unminedAddressReverts() public {
        // A plain deployment lands on an address without the required flags (overwhelmingly likely).
        vm.expectRevert();
        new VeradaHook{salt: bytes32(uint256(0))}(manager, address(this), address(vault));
    }

    function test_minerFindsDistinctValidAddresses() public view {
        bytes memory args = abi.encode(manager, address(this), address(vault));
        (address a, bytes32 s) =
            HookMiner.find(address(this), FLAGS, type(VeradaHook).creationCode, args);
        assertTrue(HookMiner.hasExactFlags(a, FLAGS));
        (address b, bytes32 s2) = HookMiner.find(
            address(this), FLAGS, type(VeradaHook).creationCode, args, uint256(s) + 1, 400_000
        );
        assertTrue(HookMiner.hasExactFlags(b, FLAGS));
        assertTrue(a != b && s != s2);
    }

    function test_minerRevertsWhenBoundTooSmall() public {
        bytes memory args = abi.encode(manager, address(this), address(vault));
        vm.expectRevert(HookMiner.SaltNotFound.selector);
        this.mineExternal(args);
    }

    function mineExternal(bytes memory args) external view {
        HookMiner.find(address(this), FLAGS, type(VeradaHook).creationCode, args, 0, 1);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(VeradaHook.ZeroAddress.selector);
        new VeradaHook(manager, address(0), address(vault));
    }

    // ------------------------------------------------------------------ configuration

    function test_configure_onlyFactory() public {
        IVeradaHook.FeeConfig memory c = _cfg(300, 0, 0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(IVeradaHook.NotFactory.selector);
        hook.configureToken(token, c);
    }

    function test_configure_storesAndDefaultsLaunchTimestamp() public {
        IVeradaHook.FeeConfig memory c = _cfg(300, 5000, 60);
        c.launchTimestamp = 0;
        hook.configureToken(token, c);
        IVeradaHook.FeeConfig memory s = hook.feeConfig(token);
        assertEq(s.baseFeeBps, 300);
        assertEq(s.sniperFeeStartBps, 5000);
        assertEq(s.sniperDecaySeconds, 60);
        assertEq(s.launchTimestamp, block.timestamp);
        assertTrue(hook.configured(token));
    }

    function test_configure_twiceReverts() public {
        hook.configureToken(token, _cfg(300, 0, 0));
        IVeradaHook.FeeConfig memory c = _cfg(200, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeradaHook.AlreadyConfigured.selector, token));
        hook.configureToken(token, c);
    }

    function test_configure_feeBounds() public {
        IVeradaHook.FeeConfig memory c = _cfg(99, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(VeradaHook.InvalidFee.selector, 99));
        hook.configureToken(token, c);
        c = _cfg(501, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(VeradaHook.InvalidFee.selector, 501));
        hook.configureToken(token, c);
        hook.configureToken(address(1), _cfg(100, 0, 0));
        hook.configureToken(address(2), _cfg(500, 0, 0));
    }

    function test_configure_sniperBounds() public {
        IVeradaHook.FeeConfig memory c = _cfg(300, 8001, 60);
        vm.expectRevert(abi.encodeWithSelector(VeradaHook.InvalidSniperFee.selector, 8001, 60));
        hook.configureToken(token, c);
        c = _cfg(300, 100, 0);
        vm.expectRevert(abi.encodeWithSelector(VeradaHook.InvalidSniperFee.selector, 100, 0));
        hook.configureToken(token, c);
        c = _cfg(300, 100, 1 days + 1);
        vm.expectRevert(
            abi.encodeWithSelector(VeradaHook.InvalidSniperFee.selector, 100, 1 days + 1)
        );
        hook.configureToken(token, c);
        hook.configureToken(address(1), _cfg(300, 8000, 1 days));
    }

    function test_currentFee_unconfiguredReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IVeradaHook.TokenNotConfigured.selector, token));
        hook.currentFeeBps(token);
    }

    // ------------------------------------------------------------------ decay schedule

    function test_decay_schedule() public {
        hook.configureToken(token, _cfg(200, 8000, 100));
        assertEq(hook.currentFeeBps(token), 8200);
        skip(50);
        assertEq(hook.sniperFeeBps(token), 4000);
        assertEq(hook.currentFeeBps(token), 4200);
        skip(49);
        assertEq(hook.sniperFeeBps(token), 80); // 8000 * 1/100
        skip(1);
        assertEq(hook.sniperFeeBps(token), 0);
        assertEq(hook.currentFeeBps(token), 200);
        skip(10_000);
        assertEq(hook.currentFeeBps(token), 200);
    }

    function test_decay_roundsUp() public {
        hook.configureToken(token, _cfg(200, 1, 3));
        skip(2); // 1 * 1/3 -> rounds up to 1
        assertEq(hook.sniperFeeBps(token), 1);
        skip(1);
        assertEq(hook.sniperFeeBps(token), 0);
    }

    function test_decay_futureLaunchUsesStart() public {
        IVeradaHook.FeeConfig memory c = _cfg(200, 3000, 100);
        c.launchTimestamp = uint40(block.timestamp + 1000);
        hook.configureToken(token, c);
        assertEq(hook.sniperFeeBps(token), 3000);
    }

    // ------------------------------------------------------------------ pool initialization

    function test_init_requiresConfiguredToken() public {
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_init_requiresDynamicFee() public {
        hook.configureToken(token, _cfg(300, 0, 0));
        PoolKey memory k = PoolKey(currency0, currency1, 3000, 60, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_init_requiresExactlyOneConfiguredSide() public {
        (Currency a, Currency b) = deployMintAndApprove2Currencies();
        // Neither side configured.
        PoolKey memory k = PoolKey(a, b, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);
        // Both sides configured is ambiguous.
        hook.configureToken(Currency.unwrap(a), _cfg(300, 0, 0));
        hook.configureToken(Currency.unwrap(b), _cfg(300, 0, 0));
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_init_registersPoolWithConsolidator() public {
        hook.configureToken(token, _cfg(300, 0, 0));
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertTrue(vault.isRegistered(token));
        (Currency c0, Currency c1, uint24 fee, int24 ts, IHooks hooks) = vault.registered(token);
        assertEq(Currency.unwrap(c0), Currency.unwrap(currency0));
        assertEq(Currency.unwrap(c1), Currency.unwrap(currency1));
        assertEq(fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(ts, 60);
        assertEq(address(hooks), address(hook));
    }

    function test_init_onePoolPerToken() public {
        hook.configureToken(token, _cfg(300, 0, 0));
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertTrue(hook.poolInitialized(token));
        k.tickSpacing = 10;
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_hookCallbacksOnlyPoolManager() public {
        hook.configureToken(token, _cfg(300, 0, 0));
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.expectRevert(VeradaHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), k, SQRT_PRICE_1_1);
    }

    function test_launchedTokenAsCurrency1() public {
        // Second hook instance treating currency1 as the launched token and currency0 as quote.
        MockConsolidator vault2 = new MockConsolidator();
        VeradaHook h2 = _deployHook(vault2);
        vault2.setHook(address(h2));
        vault = vault2;
        h2.configureToken(weth, _cfg(250, 4000, 100));
        (PoolKey memory k,) = initPool(
            currency0, currency1, IHooks(address(h2)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        modifyLiquidityRouter.modifyLiquidity(k, _liquidity(), ZERO_BYTES);

        // Exact-input, zeroForOne: currency0 in, currency1 out; the fee is taken in currency1.
        uint256 before1 = _bal(weth);
        BalanceDelta d = swap(k, true, -1e18, ZERO_BYTES);
        uint256 netOut = _bal(weth) - before1;
        assertEq(netOut, uint256(uint128(d.amount1())));
        uint256 fee = vault.deposited(weth, weth);
        assertGt(fee, 0);
        assertEq(IERC20(weth).balanceOf(address(vault)), fee);
        assertEq(fee, _ceilBps(netOut + fee, 4000));
    }

    // ------------------------------------------------------------------ swaps

    /// @dev Swaps the same trade on the hooked pool and on the hook-less reference pool (same
    ///      static fee, same liquidity) and checks the hook only took the surcharge from the
    ///      unspecified currency, which landed in the vault.
    function _checkSwap(bool zeroForOne, int256 amountSpecified) internal {
        uint256 surcharge = hook.sniperFeeBps(token);

        BalanceDelta ref = swap(refKey, zeroForOne, amountSpecified, ZERO_BYTES);
        address fc = ((amountSpecified < 0) == zeroForOne) ? weth : token;
        uint256 creditedBefore = vault.deposited(token, fc);
        uint256 vaultBefore0 = _vaultBal(token);
        uint256 vaultBefore1 = _vaultBal(weth);
        uint256 t0 = _bal(token);
        uint256 t1 = _bal(weth);
        BalanceDelta got = swap(hookKey, zeroForOne, amountSpecified, ZERO_BYTES);

        bool specifiedIs0 = (amountSpecified < 0) == zeroForOne;
        int256 refUnspec = specifiedIs0 ? int256(ref.amount1()) : int256(ref.amount0());
        int256 gotUnspec = specifiedIs0 ? int256(got.amount1()) : int256(got.amount0());
        int256 refSpec = specifiedIs0 ? int256(ref.amount0()) : int256(ref.amount1());
        int256 gotSpec = specifiedIs0 ? int256(got.amount0()) : int256(got.amount1());

        uint256 absRef = uint256(refUnspec < 0 ? -refUnspec : refUnspec);
        uint256 fee = _ceilBps(absRef, surcharge);

        // Specified side identical; unspecified side shifted by exactly the fee, against the user.
        assertEq(gotSpec, refSpec, "specified side");
        assertEq(gotUnspec, refUnspec - int256(fee), "unspecified side");

        // Real balances agree with the reported deltas.
        assertEq(int256(_bal(token)) - int256(t0), int256(got.amount0()), "bal0");
        assertEq(int256(_bal(weth)) - int256(t1), int256(got.amount1()), "bal1");

        // Fee went to the vault in the unspecified currency and was credited there.
        address feeCurrency = specifiedIs0 ? weth : token;
        uint256 d0 = _vaultBal(token) - vaultBefore0;
        uint256 d1 = _vaultBal(weth) - vaultBefore1;
        assertEq(feeCurrency == token ? d0 : d1, fee, "vault received");
        assertEq(feeCurrency == token ? d1 : d0, 0, "other currency untouched");
        assertEq(vault.deposited(token, feeCurrency) - creditedBefore, fee, "credited");
        // The hook never keeps funds and the manager nets to zero for the hook.
        assertEq(IERC20(token).balanceOf(address(hook)), 0);
        assertEq(IERC20(weth).balanceOf(address(hook)), 0);
    }

    function _vaultBal(address c) internal view returns (uint256) {
        return IERC20(c).balanceOf(address(vault));
    }

    function test_swap_noSniper_takesNoHookFee() public {
        _setupPools(BASE_BPS, 0, 0);
        _checkSwap(true, -1e18);
        assertEq(vault.calls(), 0);
        _checkSwap(false, -1e18);
        assertEq(vault.calls(), 0);
    }

    function test_swap_sniper_exactIn_zeroForOne() public {
        _setupPools(BASE_BPS, 5000, 120);
        _checkSwap(true, -1e18);
        assertGt(vault.deposited(token, weth), 0);
    }

    function test_swap_sniper_exactIn_oneForZero() public {
        _setupPools(BASE_BPS, 5000, 120);
        _checkSwap(false, -1e18);
        assertGt(vault.deposited(token, token), 0);
    }

    function test_swap_sniper_exactOut_zeroForOne() public {
        _setupPools(BASE_BPS, 5000, 120);
        _checkSwap(true, 1e18);
        assertGt(vault.deposited(token, token), 0);
    }

    function test_swap_sniper_exactOut_oneForZero() public {
        _setupPools(BASE_BPS, 5000, 120);
        _checkSwap(false, 1e18);
        assertGt(vault.deposited(token, weth), 0);
    }

    function test_swap_surchargeDecaysToZero() public {
        _setupPools(BASE_BPS, 8000, 100);
        _checkSwap(true, -1e18);
        uint256 first = vault.deposited(token, weth);

        skip(50);
        _checkSwap(true, -1e18);
        uint256 second = vault.deposited(token, weth) - first;
        assertLt(second, first);

        skip(50);
        uint256 calls = vault.calls();
        _checkSwap(true, -1e18);
        assertEq(vault.calls(), calls); // surcharge over: no further hook fee
    }

    function test_swap_lpFeeIsBaseFee() public {
        // After the window the hooked pool must price exactly like a static pool at the base fee.
        _setupPools(BASE_BPS, 8000, 10);
        skip(10);
        BalanceDelta a = swap(hookKey, true, -1e18, ZERO_BYTES);
        BalanceDelta b = swap(refKey, true, -1e18, ZERO_BYTES);
        assertEq(BalanceDelta.unwrap(a), BalanceDelta.unwrap(b));
    }

    function test_swap_unrelatedCallerCannotUseConsolidator() public {
        _setupPools(BASE_BPS, 5000, 120);
        vm.expectRevert(MockConsolidator.NotHook.selector);
        vm.prank(address(0xBAD));
        vault.consolidate(token, weth, 1);
    }

    // ------------------------------------------------------------------ oracle

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(hookKey.toId());
    }

    function test_oracle_notEnoughHistory() public {
        _setupPools(BASE_BPS, 0, 0);
        (bool ok,,) = hook.twapTick(token, 600);
        assertFalse(ok); // only the init checkpoint exists, and it is younger than the window
        skip(600);
        (ok,,) = hook.twapTick(token, 600);
        assertTrue(ok);
        (ok,,) = hook.twapTick(token, 0);
        assertFalse(ok);
    }

    function test_oracle_twapWeightsTickByDuration() public {
        _setupPools(BASE_BPS, 0, 0);
        skip(400);
        swap(hookKey, true, -100_000e18, ZERO_BYTES); // moves the tick, checkpoint at t+400
        int24 moved = _tick();
        assertTrue(moved < -100);
        skip(600);

        (bool ok, int24 avg, uint32 span) = hook.twapTick(token, 600);
        assertTrue(ok);
        assertEq(span, 600);
        assertEq(avg, moved);

        (ok, avg, span) = hook.twapTick(token, 1000);
        assertTrue(ok);
        assertEq(span, 1000);
        assertEq(avg, int24((int256(moved) * 600) / 1000));
    }

    function test_oracle_sameBlockSwapsDoNotMoveTwap() public {
        _setupPools(BASE_BPS, 0, 0);
        skip(1000);
        swap(hookKey, true, -1e18, ZERO_BYTES);
        (, int24 before,) = hook.twapTick(token, 600);
        // A manipulator pushes the price in the same block: the average is unchanged.
        swap(hookKey, true, -300_000e18, ZERO_BYTES);
        (, int24 afterTick,) = hook.twapTick(token, 600);
        assertTrue(_tick() < before - 500);
        // The pushed tick has not held for any time yet.
        assertEq(afterTick, before);
    }

    function test_oracle_checkpointSpacing() public {
        _setupPools(BASE_BPS, 0, 0);
        for (uint256 i; i < 30; ++i) {
            skip(100);
            swap(hookKey, i % 2 == 0, -1e15, ZERO_BYTES);
        }
        // 3000 seconds elapsed; the ring keeps working past its capacity.
        (bool ok,, uint32 span) = hook.twapTick(token, 1800);
        assertTrue(ok);
        assertGe(span, 1800);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_feeScheduleBounds(uint24 base, uint24 start, uint32 decay, uint32 elapsed)
        public
    {
        base = uint24(bound(base, 100, 500));
        start = uint24(bound(start, 0, 8000));
        decay = uint32(bound(decay, 1, 1 days));
        hook.configureToken(token, _cfg(base, start, decay));

        uint24 atLaunch = hook.currentFeeBps(token);
        assertEq(atLaunch, base + start);
        assertLe(atLaunch, 8500);

        skip(elapsed);
        uint24 nowFee = hook.currentFeeBps(token);
        assertGe(nowFee, base);
        assertLe(nowFee, atLaunch);
        if (elapsed >= decay) assertEq(nowFee, base);

        // Monotone non-increasing in time.
        skip(1);
        assertLe(hook.currentFeeBps(token), nowFee);
    }

    function testFuzz_configureValidation(uint24 base, uint24 start, uint32 decay) public {
        IVeradaHook.FeeConfig memory c = _cfg(base, start, decay);
        bool ok = base >= 100 && base <= 500 && start <= 8000
            && (start == 0 || (decay > 0 && decay <= 1 days));
        if (ok) {
            hook.configureToken(token, c);
            assertLe(hook.currentFeeBps(token), 8500);
        } else {
            vm.expectRevert();
            hook.configureToken(token, c);
        }
    }

    function testFuzz_swapFeeMatchesReference(
        uint24 base,
        uint24 start,
        uint32 decay,
        uint32 elapsed,
        uint96 amount,
        bool zeroForOne,
        bool exactIn
    ) public {
        base = uint24(bound(base, 100, 500));
        start = uint24(bound(start, 0, 8000));
        decay = uint32(bound(decay, 1, 1 days));
        elapsed = uint32(bound(elapsed, 0, uint256(decay) + 10));
        uint256 amt = bound(amount, 1e6, 1e21);

        _setupPools(base, start, decay);
        skip(elapsed);
        _checkSwap(zeroForOne, exactIn ? -int256(amt) : int256(amt));
    }
}
