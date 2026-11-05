// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../../script/HookMiner.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {VeradaHook} from "../../src/VeradaHook.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {
    MockDistributor,
    MockERC20,
    MockGovernor,
    MockOndoToken,
    MockWETH
} from "./ConsolidatorMocks.sol";

/// @dev Shared fixture: real v4 PoolManager, real hook, registry, vault and consolidator.
///      The launched token is a plain ERC20, the quote asset an Ondo-like token (pausable,
///      compliance gated) and the settlement asset a 6-decimals USDC stand-in.
///      Pools: token/quote with the Verada hook, quote/USDC with a static 0.3% fee.
abstract contract ConsolidatorBase is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MockERC20 internal usdc;
    MockERC20 internal meme;
    MockOndoToken internal quote;
    MockWETH internal weth;

    MockGovernor internal governor;
    MockDistributor internal distributor;
    QuoteRegistry internal registry;
    FeeVault internal vault;
    FeeConsolidator internal cons;
    VeradaHook internal hook;

    PoolKey internal tokenKey; // meme / quote, hooked
    PoolKey internal quoteKey; // quote / usdc, static fee

    address internal locker = makeAddr("locker");
    address internal treasury = makeAddr("treasury");

    uint24 internal constant BASE_BPS = 300;
    int24 internal constant TOKEN_TICK = 69_060; // |tick| of 0.001 quote per token
    int24 internal constant QUOTE_TICK = 230_280; // |tick| of ~100 USDC per quote (raw units)
    uint256 internal constant MAX_SLIPPAGE_BPS = 300;
    uint256 internal constant MAX_DEVIATION_TICKS = 1000;

    function _baseSetUp() internal {
        deployFreshManagerAndRouters();

        usdc = new MockERC20("USDC", 6);
        meme = new MockERC20("MEME", 18);
        quote = new MockOndoToken("AAPLon");
        weth = new MockWETH();

        governor = new MockGovernor();
        distributor = new MockDistributor();
        registry = new QuoteRegistry(address(this), address(usdc), address(weth));
        vault = new FeeVault(
            address(this),
            address(this),
            treasury,
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        cons = new FeeConsolidator(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
        vault.setConsolidator(address(cons));

        bytes memory args = abi.encode(manager, address(this), address(cons));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(VeradaHook).creationCode, args);
        hook = new VeradaHook{salt: salt}(manager, address(this), address(cons));
        cons.setHook(address(hook));
        cons.setSource(locker, true);

        _fund(address(this));
        vault.registerToken(address(meme));
    }

    function _fund(address who) internal {
        meme.mint(who, 1e36);
        quote.mint(who, 1e36);
        usdc.mint(who, 1e30);
        vm.startPrank(who);
        meme.approve(address(modifyLiquidityRouter), type(uint256).max);
        quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdc.approve(address(modifyLiquidityRouter), type(uint256).max);
        meme.approve(address(swapRouter), type(uint256).max);
        quote.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _sorted(address a, address b) internal pure returns (Currency c0, Currency c1) {
        (c0, c1) =
            a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    /// @dev Tick at which `base` is worth the price encoded by `|tick|` of `priceCurrency`.
    function _orientedTick(address base, address priceCurrency, int24 absTick)
        internal
        pure
        returns (int24)
    {
        // Price is currency1 per currency0. If `base` is currency0 the price of base in
        // priceCurrency is the pool price (negative tick for a price below one).
        return base < priceCurrency ? -absTick : absTick;
    }

    function _addLiquidity(PoolKey memory key, int24 tick, int256 liquidity) internal {
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: liquidity, salt: 0
            }),
            ZERO_BYTES
        );
    }

    /// @dev Registers the quote asset with its route and initializes both pools.
    function _setupPools(uint24 sniperStart, uint32 sniperDecay) internal {
        (Currency q0, Currency q1) = _sorted(address(quote), address(usdc));
        // quote is worth ~100 USDC: price of the quote in USDC is a large raw number? No: 6 vs 18
        // decimals makes 1 raw quote ~ 1e-10 raw USDC.
        quoteKey = PoolKey(q0, q1, 3000, 60, IHooks(address(0)));
        int24 qt = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        manager.initialize(quoteKey, TickMath.getSqrtPriceAtTick(qt));
        _addLiquidity(quoteKey, qt, 2e19);

        PoolKey[] memory route = new PoolKey[](1);
        route[0] = quoteKey;
        registry.addQuoteAssetWithRoute(address(quote), IQuoteRegistry.Kind.Ondo, route);
        cons.seedReferences(route);

        hook.configureToken(
            address(meme),
            IVeradaHook.FeeConfig({
                baseFeeBps: BASE_BPS,
                sniperFeeStartBps: sniperStart,
                sniperDecaySeconds: sniperDecay,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        (Currency t0, Currency t1) = _sorted(address(meme), address(quote));
        tokenKey = PoolKey(t0, t1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        int24 tt = _orientedTick(address(meme), address(quote), TOKEN_TICK);
        manager.initialize(tokenKey, TickMath.getSqrtPriceAtTick(tt));
        _addLiquidity(tokenKey, tt, 1e24);
    }

    /// @dev Delivers raw fees the way the LP locker would: transfer, then consolidate.
    function _deliver(address currency, uint256 amount) internal {
        MockERC20(currency).mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(meme), currency, amount);
    }

    function _deliverQuote(uint256 amount) internal {
        quote.mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), amount);
    }

    /// @dev Extracts the revert selector of the last ConsolidationFailed in `logs` (0 if none).
    function _lastFailure(Vm.Log[] memory logs) internal pure returns (bytes4 sel, bool found) {
        bytes32 topic0 = keccak256("ConsolidationFailed(address,address,uint256,bytes)");
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].topics[0] == topic0) {
                (, bytes memory reason) = abi.decode(logs[i - 1].data, (uint256, bytes));
                if (reason.length >= 4) {
                    assembly {
                        sel := mload(add(reason, 32))
                    }
                }
                return (sel, true);
            }
        }
    }

    function _spotTick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }
}
