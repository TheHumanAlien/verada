// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {IVeradaHook} from "./interfaces/IVeradaHook.sol";

/// @dev Pool registration entry point of the fee consolidator.
interface IConsolidatorPools {
    function registerPool(address token, PoolKey calldata key) external;
}

/// @title VeradaHook
/// @notice Uniswap v4 hook for Verada pools (token paired with an allowed quote asset).
/// @dev Fee design, per swap:
///  - The pool LP fee is dynamic. `beforeSwap` overrides it with the token's base fee
///    (within [MIN_FEE_BPS, MAX_FEE_BPS]); it accrues to the locked liquidity position and
///    reaches the FeeVault through the locker.
///  - An optional anti-sniper surcharge decays linearly from `sniperFeeStartBps` to zero over
///    `sniperDecaySeconds`. It is taken by this hook in `afterSwap` through the return delta, on
///    the unspecified currency of the swap and sent raw to the FeeConsolidator, which swaps it
///    into the settlement asset (the FeeVault only ever sees the settled asset). Swaps made by the
///    consolidator itself are exempt from the surcharge.
///  - `currentFeeBps` reports base plus the current surcharge.
///  - The hook keeps a tick-accumulator oracle per pool (checkpoints at least `OBS_INTERVAL`
///    apart) so the consolidator can bound its execution price against a TWAP.
///
///  The hook address must encode the permission flags (see `getHookPermissions`); mine a salt
///  with the HookMiner library before deploying.
contract VeradaHook is IHooks, IVeradaHook {
    using SafeCast for uint256;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice Tick accumulator checkpoint.
    struct Observation {
        uint40 timestamp;
        int56 tickCumulative;
    }

    /// @notice Oracle accumulator state of a token's pool.
    struct OracleState {
        PoolId poolId;
        uint40 lastTimestamp;
        int56 tickCumulative;
        uint8 head;
        uint8 count;
    }

    /// @notice Minimum spacing between two stored checkpoints.
    uint32 public constant OBS_INTERVAL = 5 minutes;
    /// @notice Number of checkpoints kept per pool (covers 2 hours at the minimum spacing).
    uint8 public constant OBS_CAPACITY = 24;

    /// @notice Lowest allowed base fee in basis points.
    uint24 public constant MIN_FEE_BPS = 100;
    /// @notice Highest allowed base fee in basis points.
    uint24 public constant MAX_FEE_BPS = 500;
    /// @notice Highest allowed initial anti-sniper surcharge in basis points (80%).
    uint24 public constant MAX_SNIPER_FEE_START_BPS = 8000;
    /// @notice Longest allowed anti-sniper decay window.
    uint32 public constant MAX_SNIPER_DECAY_SECONDS = 1 days;
    /// @dev Basis points denominator.
    uint256 internal constant BPS = 10_000;
    /// @dev Pips (v4 fee unit) per basis point.
    uint24 internal constant PIPS_PER_BPS = 100;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public immutable feeConsolidator;

    mapping(address token => FeeConfig) internal _feeConfigs;
    mapping(address token => bool) public configured;
    mapping(address token => bool) public poolInitialized;
    mapping(address token => OracleState) internal _oracle;
    mapping(address token => Observation[24]) internal _observations;

    error NotPoolManager();
    error InvalidFee(uint24 feeBps);
    error InvalidSniperFee(uint24 feeBps, uint32 decaySeconds);
    error InvalidPool();
    error HookNotImplemented();
    error ZeroAddress();

    /// @notice A surcharge was taken from a swap and forwarded to the consolidator.
    event SniperFeeTaken(address indexed token, address indexed currency, uint256 amount);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _factory, address _feeConsolidator) {
        if (
            address(_poolManager) == address(0) || _factory == address(0)
                || _feeConsolidator == address(0)
        ) revert ZeroAddress();
        poolManager = _poolManager;
        factory = _factory;
        feeConsolidator = _feeConsolidator;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice Permission flags this hook's address must encode.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    // ------------------------------------------------------------------ configuration

    /// @inheritdoc IVeradaHook
    function configureToken(address token, FeeConfig calldata config) external {
        if (msg.sender != factory) revert NotFactory();
        if (configured[token]) revert AlreadyConfigured(token);
        if (config.baseFeeBps < MIN_FEE_BPS || config.baseFeeBps > MAX_FEE_BPS) {
            revert InvalidFee(config.baseFeeBps);
        }
        if (config.sniperFeeStartBps > MAX_SNIPER_FEE_START_BPS) {
            revert InvalidSniperFee(config.sniperFeeStartBps, config.sniperDecaySeconds);
        }
        if (config.sniperFeeStartBps != 0) {
            if (
                config.sniperDecaySeconds == 0
                    || config.sniperDecaySeconds > MAX_SNIPER_DECAY_SECONDS
            ) {
                revert InvalidSniperFee(config.sniperFeeStartBps, config.sniperDecaySeconds);
            }
        }

        FeeConfig memory stored = config;
        if (stored.launchTimestamp == 0) stored.launchTimestamp = uint40(block.timestamp);
        _feeConfigs[token] = stored;
        configured[token] = true;
    }

    /// @inheritdoc IVeradaHook
    function feeConfig(address token) external view returns (FeeConfig memory) {
        return _feeConfigs[token];
    }

    /// @inheritdoc IVeradaHook
    function currentFeeBps(address token) public view returns (uint24) {
        if (!configured[token]) revert TokenNotConfigured(token);
        FeeConfig storage c = _feeConfigs[token];
        return c.baseFeeBps + _surchargeBps(c);
    }

    /// @notice Current anti-sniper surcharge of `token` in basis points.
    function sniperFeeBps(address token) external view returns (uint24) {
        if (!configured[token]) revert TokenNotConfigured(token);
        return _surchargeBps(_feeConfigs[token]);
    }

    function _surchargeBps(FeeConfig storage c) internal view returns (uint24) {
        uint256 start = c.sniperFeeStartBps;
        uint256 decay = c.sniperDecaySeconds;
        if (start == 0 || decay == 0) return 0;
        uint256 launch = c.launchTimestamp;
        if (block.timestamp <= launch) return uint24(start);
        uint256 elapsed = block.timestamp - launch;
        if (elapsed >= decay) return 0;
        // Rounded up: the cause pool benefits from any rounding.
        return uint24(FullMath.mulDivRoundingUp(start, decay - elapsed, decay));
    }

    /// @dev The launched token is whichever side of the pool the factory configured. The quote
    ///      asset was already validated by the factory against the quote registry.
    function _tokenOf(PoolKey calldata key) internal view returns (address token) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (configured[c0] && !configured[c1]) return c0;
        if (configured[c1] && !configured[c0]) return c1;
        revert InvalidPool();
    }

    // ------------------------------------------------------------------ oracle

    /// @dev Accrues the tick that held since the last update and stores a checkpoint when due.
    function _writeObservation(address token, int24 tick) internal {
        OracleState storage s = _oracle[token];
        uint256 dt = block.timestamp - s.lastTimestamp;
        if (dt != 0) {
            s.tickCumulative += int56(tick) * int56(int256(dt));
            s.lastTimestamp = uint40(block.timestamp);
        }
        Observation storage last = _observations[token][s.head];
        if (block.timestamp - last.timestamp >= OBS_INTERVAL) {
            uint8 next = (s.head + 1) % OBS_CAPACITY;
            _observations[token][next] =
                Observation({timestamp: uint40(block.timestamp), tickCumulative: s.tickCumulative});
            s.head = next;
            if (s.count < OBS_CAPACITY) ++s.count;
        }
    }

    /// @notice Time-weighted average tick of `token`'s pool over at least `window` seconds.
    /// @dev Uses the newest checkpoint that is at least `window` old. Returns `ok == false` when
    ///      the pool is younger than `window`. The average excludes manipulation within the
    ///      current block because each swap is weighted by the tick that held before it.
    /// @return ok Whether a long enough history exists.
    /// @return avgTick The average tick over the covered span.
    /// @return span The number of seconds the average covers.
    function twapTick(address token, uint32 window)
        external
        view
        returns (bool ok, int24 avgTick, uint32 span)
    {
        OracleState storage s = _oracle[token];
        if (s.count == 0 || window == 0) return (false, 0, 0);
        (, int24 tick,,) = poolManager.getSlot0(s.poolId);
        int256 cumNow = int256(s.tickCumulative) + int256(tick)
            * int256(block.timestamp - uint256(s.lastTimestamp));

        uint256 target = block.timestamp > window ? block.timestamp - window : 0;
        uint8 idx = s.head;
        for (uint8 i; i < s.count; ++i) {
            Observation memory o = _observations[token][idx];
            if (o.timestamp <= target) {
                uint256 elapsed = block.timestamp - o.timestamp;
                if (elapsed == 0) return (false, 0, 0);
                return (
                    true,
                    int24((cumNow - int256(o.tickCumulative)) / int256(elapsed)),
                    uint32(elapsed)
                );
            }
            idx = idx == 0 ? OBS_CAPACITY - 1 : idx - 1;
        }
        return (false, 0, 0);
    }

    // ------------------------------------------------------------------ hooks

    function beforeInitialize(address, PoolKey calldata key, uint160)
        external
        onlyPoolManager
        returns (bytes4)
    {
        address token = _tokenOf(key);
        if (
            address(key.hooks) != address(this) || !LPFeeLibrary.isDynamicFee(key.fee)
                || poolInitialized[token]
        ) revert InvalidPool();
        poolInitialized[token] = true;

        OracleState storage s = _oracle[token];
        s.poolId = key.toId();
        s.lastTimestamp = uint40(block.timestamp);
        _observations[token][0] =
            Observation({timestamp: uint40(block.timestamp), tickCumulative: 0});
        s.count = 1;

        IConsolidatorPools(feeConsolidator).registerPool(token, key);
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address token = _tokenOf(key);
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        _writeObservation(token, tick);
        uint24 lpFee = _feeConfigs[token].baseFeeBps * PIPS_PER_BPS;
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            lpFee | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // The consolidator's own swaps never pay the surcharge (they would feed themselves).
        if (sender == feeConsolidator) return (IHooks.afterSwap.selector, 0);
        address token = _tokenOf(key);
        uint256 surcharge = _surchargeBps(_feeConfigs[token]);
        if (surcharge == 0) return (IHooks.afterSwap.selector, 0);

        // The unspecified currency is the output for exact-input swaps and the input for
        // exact-output swaps.
        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency feeCurrency, int128 unspecified) = specifiedIsCurrency0
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());
        uint256 base =
            unspecified < 0 ? uint256(uint128(-unspecified)) : uint256(uint128(unspecified));

        uint256 fee = FullMath.mulDivRoundingUp(base, surcharge, BPS);
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        // Raw fees go to the consolidator. It cannot unlock the pool manager from inside this
        // swap, so it records the amount and settles it in a later transaction.
        poolManager.take(feeCurrency, feeConsolidator, fee);
        IFeeConsolidator(feeConsolidator).consolidate(token, Currency.unwrap(feeCurrency), fee);
        emit SniperFeeTaken(token, Currency.unwrap(feeCurrency), fee);

        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    // ------------------------------------------------------------------ unused hooks

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
