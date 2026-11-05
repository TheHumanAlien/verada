// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";

/// @dev WETH as the quote asset, routed through a native ETH / USDC pool (the deepest venue).
///      The consolidator unwraps inside the unlock.
contract FeeConsolidatorWethTest is ConsolidatorBase {
    PoolKey internal ethKey; // native ETH / USDC
    PoolKey internal wethPoolKey; // meme / WETH, hooked
    int24 internal constant ETH_TICK = -196_260; // ~3000 USDC per ETH in raw units

    function setUp() public {
        _baseSetUp();
        vm.deal(address(this), 1_000_000 ether);

        ethKey = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 10, IHooks(address(0))
        );
        manager.initialize(ethKey, TickMath.getSqrtPriceAtTick(ETH_TICK));
        modifyLiquidityRouter.modifyLiquidity{value: 10_000 ether}(
            ethKey,
            ModifyLiquidityParams({
                tickLower: ETH_TICK - 6000,
                tickUpper: ETH_TICK + 6000,
                liquidityDelta: 3e15,
                salt: 0
            }),
            ZERO_BYTES
        );

        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethKey;
        registry.addQuoteAssetWithRoute(address(weth), IQuoteRegistry.Kind.Native, route);
        cons.seedReferences(route);

        hook.configureToken(
            address(meme),
            IVeradaHook.FeeConfig({
                baseFeeBps: BASE_BPS,
                sniperFeeStartBps: 0,
                sniperDecaySeconds: 0,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        (Currency a, Currency b) = _sorted(address(meme), address(weth));
        wethPoolKey = PoolKey(a, b, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        int24 t = _orientedTick(address(meme), address(weth), TOKEN_TICK);
        manager.initialize(wethPoolKey, TickMath.getSqrtPriceAtTick(t));

        meme.mint(address(this), 1e36);
        weth.deposit{value: 100_000 ether}();
        meme.approve(address(modifyLiquidityRouter), type(uint256).max);
        weth.approve(address(modifyLiquidityRouter), type(uint256).max);
        _addLiquidity(wethPoolKey, t, 1e24);
    }

    function _deliverWeth(address currency, uint256 amount) internal {
        if (currency == address(weth)) {
            vm.deal(address(this), address(this).balance + amount);
            weth.deposit{value: amount}();
            weth.transfer(address(cons), amount);
        } else {
            meme.mint(address(cons), amount);
        }
        vm.prank(locker);
        cons.consolidate(address(meme), currency, amount);
    }

    function test_wethQuoteSide_unwrapsAndSwaps() public {
        _deliverWeth(address(weth), 1 ether);
        assertEq(cons.heldFees(address(meme), address(weth)), 0);
        assertEq(weth.balanceOf(address(cons)), 0);
        assertEq(address(cons).balance, 0);
        uint256 got = usdc.balanceOf(address(vault));
        // ~3000 USDC per ETH less the 0.05% pool fee and tiny impact.
        assertGt(got, 2900e6);
        assertLt(got, 3010e6);
    }

    function test_wethTokenSide_threeSteps() public {
        skip(1900);
        _deliverWeth(address(meme), 1000e18);
        assertEq(cons.heldFees(address(meme), address(meme)), 0);
        assertEq(meme.balanceOf(address(cons)), 0);
        assertEq(weth.balanceOf(address(cons)), 0);
        assertEq(address(cons).balance, 0);
        // 1000 tokens ~ 1 WETH ~ 3000 USDC before fees (base 3% + 0.05%).
        uint256 got = usdc.balanceOf(address(vault));
        assertGt(got, 2700e6);
        assertLt(got, 3010e6);
        assertEq(vault.causePool(address(meme)) + vault.platformAccrued(), got);
    }

    function test_cannotReceiveStrayEth() public {
        vm.expectRevert();
        payable(address(cons)).transfer(1 ether);
    }

    function test_unwrapFailureHolds() public {
        // Break the route pool's liquidity price so the reference guard trips.
        PoolKey[] memory none = new PoolKey[](1);
        none[0] = ethKey;
        cons.setReference(ethKey, ETH_TICK + 5000);
        vm.recordLogs();
        _deliverWeth(address(weth), 1 ether);
        (, bool found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(cons.heldFees(address(meme), address(weth)), 1 ether);
        assertEq(weth.balanceOf(address(cons)), 1 ether);
        // Re-anchor and retry.
        cons.seedReferences(none);
        assertGt(cons.retry(address(meme), address(weth)), 0);
    }
}
