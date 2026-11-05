// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../../script/HookMiner.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {VeradaHook} from "../../src/VeradaHook.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {MockDistributor, MockERC20, MockGovernor} from "../consolidator/ConsolidatorMocks.sol";

interface ITokenPauseManager {
    function pauseToken(address token) external;
    function unpauseToken(address token) external;
    function isTokenPaused(address token) external view returns (bool);
    function PAUSE_TOKEN_ROLE() external view returns (bytes32);
    function UNPAUSE_TOKEN_ROLE() external view returns (bytes32);
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

interface IOndoToken is IERC20 {
    function tokenPauseManager() external view returns (address);
    function compliance() external view returns (address);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

/// @notice Mainnet-fork evidence that Ondo tokens work as v4 pool currencies and that the
///         consolidator can route fees from them into USDC through real pools.
///         Skipped when ETH_RPC_URL is unset.
/// @dev Ondo tokens are gated only by a pause manager and a compliance contract (blocklist and
///      sanctions list); there is no allowlist, so contracts such as the PoolManager, the hook
///      and the consolidator can hold and move them unless explicitly blocked. The pause and
///      block cases are exercised with the real pause manager and a reverting compliance check.
contract ConsolidatorForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    address internal constant SLV_ON = 0xF3e4872e6a4cF365888D93b6146a2bAA7348F1A4;
    address internal constant USD_ON = 0xAcE8E719899F6E91831B18AE746C9A965c2119F1;
    address internal constant AAPL_ON = 0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MockERC20 internal meme;
    MockGovernor internal governor;
    QuoteRegistry internal registry;
    FeeVault internal vault;
    FeeConsolidator internal cons;
    VeradaHook internal hook;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolSwapTest internal swapRouter;

    address internal locker = makeAddr("locker");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // Sanity: the addresses are what we think they are.
        assertGt(address(PM).code.length, 0, "no pool manager");
        assertEq(IOndoToken(USDC).decimals(), 6);
        assertEq(keccak256(bytes(IOndoToken(WETH).symbol())), keccak256("WETH"));
        assertEq(keccak256(bytes(IOndoToken(AMZN_ON).symbol())), keccak256("AMZNon"));

        meme = new MockERC20("MEME", 18);
        governor = new MockGovernor();
        registry = new QuoteRegistry(address(this), USDC, WETH);
        vault = new FeeVault(
            address(this),
            address(this),
            makeAddr("treasury"),
            IEpochGovernor(address(governor)),
            address(new MockDistributor()),
            USDC
        );
        cons = new FeeConsolidator(
            address(this),
            PM,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            WETH,
            300,
            1500
        );
        vault.setConsolidator(address(cons));

        bytes memory args = abi.encode(PM, address(this), address(cons));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(VeradaHook).creationCode, args);
        hook = new VeradaHook{salt: salt}(PM, address(this), address(cons));
        cons.setHook(address(hook));
        cons.setSource(locker, true);
        vault.registerToken(address(meme));

        liquidityRouter = new PoolModifyLiquidityTest(PM);
        swapRouter = new PoolSwapTest(PM);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Real pools verified by id: Ondo token / USDC, 1% fee, no hook.
    function _realKey(address ondo, uint24 fee, int24 spacing)
        internal
        pure
        returns (PoolKey memory)
    {
        (address a, address b) = ondo < USDC ? (ondo, USDC) : (USDC, ondo);
        return PoolKey(Currency.wrap(a), Currency.wrap(b), fee, spacing, IHooks(address(0)));
    }

    function _amznKey() internal pure returns (PoolKey memory k) {
        k = _realKey(AMZN_ON, 10_000, 100);
        assertEq(
            PoolId.unwrap(k.toId()),
            0x267d70816c37d531818dfe2224a1e5beac46fe74929f2370433c1918facb3a8d,
            "AMZNon/USDC pool id"
        );
    }

    /// @dev Takes Ondo tokens out of the pool manager (itself a real transfer from the PM).
    function _fromPoolManager(address ondo, address to, uint256 amount) internal {
        vm.prank(address(PM));
        IERC20(ondo).transfer(to, amount);
    }

    function _liquidity(PoolKey memory k) internal view returns (uint128) {
        return PM.getLiquidity(k.toId());
    }

    function _registerAmzn() internal returns (PoolKey memory k) {
        k = _amznKey();
        require(_liquidity(k) > 0, "no live liquidity in the AMZNon/USDC pool");
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = k;
        registry.addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, route);
        cons.seedReferences(route);
    }

    function _lastFailureSel(Vm.Log[] memory logs) internal pure returns (bytes4 sel, bool found) {
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

    function _deliverAmzn(uint256 amount) internal {
        _fromPoolManager(AMZN_ON, address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(meme), AMZN_ON, amount);
    }

    // ------------------------------------------------------------------ token behaviour

    /// @notice Evidence: real Ondo tokens move PoolManager -> arbitrary contract -> PoolManager.
    function test_fork_ondoTokensMoveThroughPoolManager() public {
        address[4] memory tokens = [AMZN_ON, SLV_ON, USD_ON, AAPL_ON];
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            // Stock tokens expose a pause manager; USDon is a different contract without one.
            try IOndoToken(t).tokenPauseManager() returns (address mgr) {
                assertFalse(ITokenPauseManager(mgr).isTokenPaused(t), "token paused right now");
            } catch {
                console2.log("no pause manager getter on", IOndoToken(t).symbol());
            }

            uint256 pmBalance = IERC20(t).balanceOf(address(PM));
            uint256 amount = pmBalance / 1000;
            // PoolManager -> consolidator (fresh contract, never allowlisted anywhere).
            _fromPoolManager(t, address(cons), amount);
            assertEq(IERC20(t).balanceOf(address(cons)), amount);
            // Consolidator -> PoolManager (the settle direction).
            vm.prank(address(cons));
            IERC20(t).transfer(address(PM), amount);
            // Hook can receive too (the surcharge destination is the consolidator, but the hook
            // address must not be restricted either).
            _fromPoolManager(t, address(hook), amount);
            assertEq(IERC20(t).balanceOf(address(hook)), amount);

            console2.log(
                IOndoToken(t).symbol(), "pm/consolidator/hook transfers ok, pm balance", pmBalance
            );
        }
    }

    // ------------------------------------------------------------------ quote side routing

    function test_fork_quoteSideRealOndoToUsdc() public {
        PoolKey memory k = _registerAmzn();
        _launchPool(0, 0);

        uint256 amount = 0.02e18;
        (uint160 sqrtP,,,) = PM.getSlot0(k.toId());
        bool ondoIs0 = Currency.unwrap(k.currency0) == AMZN_ON;
        uint256 spotUsdc = ondoIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);

        _deliverAmzn(amount);

        assertEq(cons.heldFees(address(meme), AMZN_ON), 0, "should have consolidated");
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        console2.log("AMZNon in (raw)", amount);
        console2.log("USDC out (6dp)", got);
        console2.log("USDC at spot", spotUsdc);
        assertGt(got, (spotUsdc * 97) / 100); // 1% pool fee plus impact, inside the guard
        assertLe(got, spotUsdc);
        assertEq(IERC20(USDC).balanceOf(address(cons)), 0);
        assertEq(IERC20(AMZN_ON).balanceOf(address(cons)), 0);
        // 10 / 90 on the consolidated amount.
        assertEq(vault.platformAccrued(), (got * 1000) / 10_000);
        assertEq(vault.causePool(address(meme)), got - vault.platformAccrued());
    }

    function test_fork_pausedOndoHoldsThenRetries() public {
        _registerAmzn();
        _launchPool(0, 0);
        ITokenPauseManager pm_ = ITokenPauseManager(IOndoToken(AMZN_ON).tokenPauseManager());
        address pauser = pm_.getRoleMember(pm_.PAUSE_TOKEN_ROLE(), 0);
        address unpauser = pm_.getRoleMember(pm_.UNPAUSE_TOKEN_ROLE(), 0);

        // Fund first, then pause (pausing blocks the PM transfer itself, as in production).
        uint256 amount = 0.01e18;
        _fromPoolManager(AMZN_ON, address(cons), amount);
        vm.prank(pauser);
        pm_.pauseToken(AMZN_ON);
        assertTrue(pm_.isTokenPaused(AMZN_ON));

        vm.recordLogs();
        vm.prank(locker);
        cons.consolidate(address(meme), AMZN_ON, amount); // must not revert
        (, bool found) = _lastFailureSel(vm.getRecordedLogs());
        assertTrue(found, "ConsolidationFailed expected");
        assertEq(cons.heldFees(address(meme), AMZN_ON), amount);
        assertEq(IERC20(AMZN_ON).balanceOf(address(cons)), amount);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 0);

        // Retrying while paused surfaces the token's own revert and keeps the balance.
        vm.expectRevert();
        cons.retry(address(meme), AMZN_ON);
        assertEq(cons.heldFees(address(meme), AMZN_ON), amount);

        vm.prank(unpauser);
        pm_.unpauseToken(AMZN_ON);
        uint256 out = cons.retry(address(meme), AMZN_ON);
        assertGt(out, 0);
        assertEq(cons.heldFees(address(meme), AMZN_ON), 0);
        console2.log("recovered after unpause, USDC out", out);
    }

    function test_fork_blockedConsolidatorOrPoolManagerHolds() public {
        _registerAmzn();
        _launchPool(0, 0);
        address compliance = IOndoToken(AMZN_ON).compliance();
        uint256 amount = 0.01e18;
        _fromPoolManager(AMZN_ON, address(cons), amount);

        // Simulate the compliance check rejecting the pool manager as a counterparty.
        vm.mockCallRevert(
            compliance,
            abi.encodeWithSignature("checkIsCompliant(address)", address(PM)),
            abi.encodeWithSignature("UserBlocked()")
        );
        vm.recordLogs();
        vm.prank(locker);
        cons.consolidate(address(meme), AMZN_ON, amount);
        (, bool found) = _lastFailureSel(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(cons.heldFees(address(meme), AMZN_ON), amount);

        vm.clearMockedCalls();
        assertGt(cons.retry(address(meme), AMZN_ON), 0);
    }

    // ------------------------------------------------------------------ full hook flow

    /// @dev Pool meme / AMZNon with the real hook on the real PoolManager, with liquidity funded
    ///      by real AMZNon taken from the PoolManager.
    function _launchPool(uint24 sniperStart, uint32 sniperDecay)
        internal
        returns (PoolKey memory key)
    {
        hook.configureToken(
            address(meme),
            IVeradaHook.FeeConfig({
                baseFeeBps: 300,
                sniperFeeStartBps: sniperStart,
                sniperDecaySeconds: sniperDecay,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        (address a, address b) =
            address(meme) < AMZN_ON ? (address(meme), AMZN_ON) : (AMZN_ON, address(meme));
        key = PoolKey(
            Currency.wrap(a),
            Currency.wrap(b),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            60,
            IHooks(address(hook))
        );
        // 0.001 AMZNon per token.
        int24 t = address(meme) < AMZN_ON ? int24(-69_060) : int24(69_060);
        PM.initialize(key, TickMath.getSqrtPriceAtTick(t));

        meme.mint(address(this), 1e30);
        _fromPoolManager(AMZN_ON, address(this), 0.5e18);
        meme.approve(address(liquidityRouter), type(uint256).max);
        meme.approve(address(swapRouter), type(uint256).max);
        IERC20(AMZN_ON).approve(address(liquidityRouter), type(uint256).max);
        IERC20(AMZN_ON).approve(address(swapRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: t - 6000, tickUpper: t + 6000, liquidityDelta: 1e19, salt: 0
            }),
            ""
        );
        tokenKey = key;
    }

    PoolKey internal tokenKey;

    function test_fork_tokenSideTwoHopsThroughRealOndoPool() public {
        _registerAmzn();
        _launchPool(0, 0);
        skip(1900); // TWAP history for the token pool

        uint256 amount = 5e18; // ~0.005 AMZNon worth of tokens
        meme.mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(meme), address(meme), amount);

        assertEq(cons.heldFees(address(meme), address(meme)), 0, "token side not consolidated");
        assertEq(IERC20(AMZN_ON).balanceOf(address(cons)), 0);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        console2.log("meme in", amount);
        console2.log("USDC out (6dp)", got);
        assertGt(got, 0);
    }

    function test_fork_sniperSurchargeInOndoIsHeldThenConsolidated() public {
        _registerAmzn();
        PoolKey memory key = _launchPool(5000, 1 days);
        skip(1900);

        // An exact-input sell of the token: the surcharge is taken in AMZNon by the hook, sent
        // straight to the consolidator, and held because the pool manager is busy.
        bool memeIs0 = Currency.unwrap(key.currency0) == address(meme);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: memeIs0,
                amountSpecified: -int256(20e18),
                sqrtPriceLimitX96: memeIs0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 held = cons.heldFees(address(meme), AMZN_ON);
        assertGt(held, 0, "surcharge not delivered");
        assertEq(IERC20(AMZN_ON).balanceOf(address(cons)), held);
        assertEq(IERC20(AMZN_ON).balanceOf(address(hook)), 0);

        uint256 out = cons.retry(address(meme), AMZN_ON);
        assertGt(out, 0);
        assertEq(IERC20(USDC).balanceOf(address(vault)), out);
        console2.log("surcharge (AMZNon raw)", held);
        console2.log("consolidated USDC", out);
    }

    // ------------------------------------------------------------------ WETH through a native pool

    function test_fork_wethQuoteThroughRealEthUsdcPool() public {
        PoolKey memory ethKey =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        assertEq(
            PoolId.unwrap(ethKey.toId()),
            0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27,
            "ETH/USDC pool id"
        );
        assertGt(_liquidity(ethKey), 0);

        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethKey;
        registry.addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        cons.seedReferences(route);

        hook.configureToken(
            address(meme),
            IVeradaHook.FeeConfig({
                baseFeeBps: 300,
                sniperFeeStartBps: 0,
                sniperDecaySeconds: 0,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        (address a, address b) =
            address(meme) < WETH ? (address(meme), WETH) : (WETH, address(meme));
        PoolKey memory k = PoolKey(
            Currency.wrap(a),
            Currency.wrap(b),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            60,
            IHooks(address(hook))
        );
        PM.initialize(
            k, TickMath.getSqrtPriceAtTick(address(meme) < WETH ? int24(-69_060) : int24(69_060))
        );

        vm.deal(address(this), 10 ether);
        IWETH9(WETH).deposit{value: 2 ether}();
        IWETH9(WETH).transfer(address(cons), 1 ether);
        vm.prank(locker);
        cons.consolidate(address(meme), WETH, 1 ether);

        assertEq(cons.heldFees(address(meme), WETH), 0);
        assertEq(address(cons).balance, 0);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        console2.log("1 WETH -> USDC (6dp)", got);
        assertGt(got, 100e6); // sanity floor; the spot price guard is the real protection
    }
}
