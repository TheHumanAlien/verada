// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "./interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "./interfaces/IVeradaHook.sol";

interface IConsolidatorRegistry is IQuoteRegistry {
    function routeOf(address asset) external view returns (PoolKey[] memory);
    function settlementAsset() external view returns (address);
}

interface IHookOracle {
    function twapTick(address token, uint32 window)
        external
        view
        returns (bool ok, int24 twapTick, uint32 span);
}

interface IWETH {
    function withdraw(uint256 amount) external;
}

/// @title FeeConsolidator
/// @notice Converts raw pool fees (the launched token and its quote asset) into the settlement
///         asset (USDC) through Uniswap v4 and credits them to the FeeVault.
/// @dev Flow: a source (the hook, the LP locker) delivers raw fees and calls `consolidate`. The
///      amount is recorded as held. If the pool manager is locked, the consolidator unlocks it
///      and swaps along the route (token pool first for the token side, then the quote asset's
///      registry route) atomically; the USDC is forwarded to the vault in the same transaction.
///      If the route reverts for any reason (paused or non-compliant Ondo token, no liquidity,
///      guard violation) the raw amount stays held, `ConsolidationFailed` is emitted, and
///      `retry` can be called by anyone. If the pool manager is already unlocked (the hook runs
///      inside a swap) nothing can be swapped yet, so the amount is simply held for `retry`.
///
///      Price guards, applied to every hop:
///       1. execution must return at least `spot * (1 - maxSlippageBps - hopFee)`;
///       2. spot must be within `maxDeviationTicks` of a reference: the hook's TWAP for the
///          token's own pool, an owner seeded moving reference for registry route pools.
///      A failed guard fails closed (the raw balance is held), never executes at a bad price.
///
///      Epoch attribution: every held raw amount is tagged with the epoch in which it was earned
///      (the current epoch for hook fees, the epochs of the accrual interval for LP fees). A swap
///      spends the oldest tags first and splits its output over them in proportion, so the vault
///      credits each epoch with what it earned, whoever triggers the swap and whenever.
contract FeeConsolidator is IFeeConsolidator, IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice Per-pool reference tick for pools outside the hook oracle.
    struct Reference {
        int24 tick;
        /// @dev Time up to which the elapsed time has been applied to `tick`.
        uint40 updatedAt;
        bool set;
        /// @dev Owner chosen anchor; the moving tick stays within `anchorBand` of it.
        int24 anchor;
        /// @dev When the owner set `anchor`; the band widens with the time since then.
        uint40 anchoredAt;
    }

    uint256 public constant BPS = 10_000;
    /// @notice Hard ceiling for `maxSlippageBps`.
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 2000;
    /// @notice Highest pool fee a hop may charge.
    uint256 public constant MAX_HOP_FEE_BPS = 1000;
    /// @notice TWAP window used for the token's own pool.
    uint32 public constant TWAP_WINDOW = 30 minutes;
    /// @notice Time over which a reference moves fully to spot after a successful hop.
    uint256 public constant REFERENCE_WINDOW = 1 days;
    /// @notice Time over which the anchor band widens by one more `maxDriftTicks`. A sustained
    ///         market trend slower than this is followed without the owner; a faster one, or a
    ///         gap, still fails closed until the owner re-anchors.
    uint256 public constant ANCHOR_WIDENING_PERIOD = 7 days;
    /// @notice Widest anchor band, the full usable tick range.
    uint256 public constant MAX_ANCHOR_BAND = uint256(int256(TickMath.MAX_TICK)) * 2;
    /// @notice Most epochs one accrual interval is spread over; anything older is attributed
    ///         to the oldest of them.
    uint256 public constant MAX_ACCRUAL_EPOCHS = 52;

    IPoolManager public immutable poolManager;
    IConsolidatorRegistry public immutable quoteRegistry;
    IFeeVault public immutable vault;
    /// @notice The governor whose epochs fees are attributed to (the vault's governor).
    IEpochGovernor public immutable governor;
    /// @inheritdoc IFeeConsolidator
    address public immutable settlementAsset;
    address public immutable weth;

    /// @inheritdoc IFeeConsolidator
    uint256 public maxSlippageBps;
    /// @notice Largest tolerated distance, in ticks (about one basis point each), between spot
    ///         and its reference.
    uint256 public maxDeviationTicks;
    /// @notice Furthest the automatic reference may drift from its owner set anchor, in ticks.
    uint256 public maxDriftTicks;

    /// @notice The hook that registers pools.
    address public hook;
    mapping(address account => bool allowed) public isSource;

    mapping(address token => PoolKey) private _poolKeys;
    mapping(address token => address quote) public quoteOf;
    mapping(address token => mapping(address currency => uint256)) private _held;
    /// @dev `_held` split by accrual epoch (token => currency => epoch => amount); the parts sum
    ///      to `_held`.
    mapping(address => mapping(address => mapping(uint256 => uint256))) private _heldIn;
    /// @dev No part of `_held` is tagged with an epoch below this one.
    mapping(address token => mapping(address currency => uint256)) private _firstHeldEpoch;
    mapping(address currency => uint256) public totalHeld;
    mapping(PoolId id => Reference) public references;

    event SourceSet(address indexed account, bool allowed);
    event HookSet(address indexed hook);
    event PoolRegistered(address indexed token, address indexed quote, PoolId indexed poolId);
    event MaxDeviationTicksUpdated(uint256 ticks);
    event MaxDriftTicksUpdated(uint256 ticks);
    event ReferenceSet(PoolId indexed poolId, int24 tick);
    event Rescued(address indexed currency, address indexed to, uint256 amount);

    error ZeroAddress();
    error SettlementMismatch();
    error HookAlreadySet();
    error UnknownToken(address token);
    error InvalidCurrency(address token, address currency);
    error PoolAlreadyRegistered(address token);
    error QuoteNotRoutable(address quote);
    error NoRoute(address currency);
    error PoolManagerBusy();
    error PoolNotInitialized(PoolId id);
    error PartialFill(uint256 spent, uint256 expected);
    error HopFeeTooHigh(uint256 feeBps);
    error OracleUnavailable(address token);
    error ReferenceNotSet(PoolId id);
    error PriceDeviation(int24 spotTick, int24 referenceTick);
    error UnbackedDeposit(address currency, uint256 balance, uint256 required);
    error NothingToRescue(address currency);
    error AmountExceedsHeld(uint256 amount, uint256 held);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    constructor(
        address owner_,
        IPoolManager poolManager_,
        IConsolidatorRegistry quoteRegistry_,
        IFeeVault vault_,
        address weth_,
        uint256 maxSlippageBps_,
        uint256 maxDeviationTicks_
    ) Ownable(owner_) {
        if (
            address(poolManager_) == address(0) || address(quoteRegistry_) == address(0)
                || address(vault_) == address(0) || weth_ == address(0)
        ) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING_BPS) revert InvalidSlippage(maxSlippageBps_);
        address settlement = vault_.settlementAsset();
        if (settlement == address(0) || quoteRegistry_.settlementAsset() != settlement) {
            revert SettlementMismatch();
        }
        IEpochGovernor governor_ = vault_.governor();
        if (address(governor_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        quoteRegistry = quoteRegistry_;
        vault = vault_;
        governor = governor_;
        weth = weth_;
        settlementAsset = settlement;
        maxSlippageBps = maxSlippageBps_;
        maxDeviationTicks = maxDeviationTicks_;
        // Default drift band: a fraction of the deviation guard, so the guard stays meaningful.
        maxDriftTicks = maxDeviationTicks_ / 2;
    }

    receive() external payable {
        // Only the unwrap of WETH is expected to send native ETH.
        if (msg.sender != weth && msg.sender != address(poolManager)) revert NotAuthorized();
    }

    // ------------------------------------------------------------------ administration

    /// @notice Sets the hook (once). The hook is also a fee source and the only pool registrar.
    function setHook(address hook_) external onlyOwner {
        if (hook_ == address(0)) revert ZeroAddress();
        if (hook != address(0)) revert HookAlreadySet();
        hook = hook_;
        isSource[hook_] = true;
        emit HookSet(hook_);
        emit SourceSet(hook_, true);
    }

    /// @notice Allows or disallows an account (hook, LP locker) to deliver fees.
    function setSource(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isSource[account] = allowed;
        emit SourceSet(account, allowed);
    }

    /// @notice Sets the maximum slippage versus spot in basis points.
    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING_BPS) revert InvalidSlippage(bps);
        maxSlippageBps = bps;
        emit MaxSlippageBpsUpdated(bps);
    }

    /// @notice Sets the maximum tick distance between spot and its reference.
    function setMaxDeviationTicks(uint256 ticks) external onlyOwner {
        maxDeviationTicks = ticks;
        emit MaxDeviationTicksUpdated(ticks);
    }

    /// @notice Sets how far the automatic reference may move away from its anchor.
    function setMaxDriftTicks(uint256 ticks) external onlyOwner {
        maxDriftTicks = ticks;
        emit MaxDriftTicksUpdated(ticks);
    }

    /// @notice Seeds the reference of route pools with their current spot tick.
    /// @dev Owner judgement: only seed while the pool trades at a fair price. Also used to
    ///      re-anchor a pool after a legitimate large move (for example an Ondo reopening gap).
    function seedReferences(PoolKey[] calldata keys) external onlyOwner {
        for (uint256 i; i < keys.length; ++i) {
            PoolId id = keys[i].toId();
            (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(id);
            if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);
            references[id] =
                Reference(tick, uint40(block.timestamp), true, tick, uint40(block.timestamp));
            emit ReferenceSet(id, tick);
        }
    }

    /// @notice Sets a pool reference explicitly (for example from an external price).
    function setReference(PoolKey calldata key, int24 tick) external onlyOwner {
        PoolId id = key.toId();
        references[id] =
            Reference(tick, uint40(block.timestamp), true, tick, uint40(block.timestamp));
        emit ReferenceSet(id, tick);
    }

    /// @notice Sends balances not owed to any token (dust, accidental transfers) to `to`.
    function rescueExcess(address currency, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(currency).balanceOf(address(this));
        uint256 owed = totalHeld[currency];
        if (balance <= owed) revert NothingToRescue(currency);
        uint256 excess = balance - owed;
        IERC20(currency).safeTransfer(to, excess);
        emit Rescued(currency, to, excess);
    }

    // ------------------------------------------------------------------ pool registration

    /// @notice Records the pool of a launched token. Called by the hook when the pool initializes.
    function registerPool(address token, PoolKey calldata key) external {
        if (msg.sender != hook) revert NotAuthorized();
        if (quoteOf[token] != address(0)) revert PoolAlreadyRegistered(token);
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        address quote = c0 == token ? c1 : c0;
        if (c0 != token && c1 != token) revert InvalidCurrency(token, token);
        if (quote == settlementAsset || token == settlementAsset) revert QuoteNotRoutable(quote);
        if (!quoteRegistry.isAllowed(quote) || quoteRegistry.routeOf(quote).length == 0) {
            revert QuoteNotRoutable(quote);
        }
        _poolKeys[token] = key;
        quoteOf[token] = quote;
        emit PoolRegistered(token, quote, key.toId());
    }

    /// @notice The pool key registered for `token`.
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        if (quoteOf[token] == address(0)) revert UnknownToken(token);
        return _poolKeys[token];
    }

    // ------------------------------------------------------------------ consolidation

    /// @inheritdoc IFeeConsolidator
    function consolidate(address token, address currency, uint256 amount) external nonReentrant {
        if (!_receive(token, currency, amount)) return;
        _hold(token, currency, governor.currentEpoch(), amount);
        _attempt(token, currency);
    }

    /// @inheritdoc IFeeConsolidator
    function consolidateAccrued(
        address token,
        address currency,
        uint256 amount,
        uint256 accruedSince
    ) external nonReentrant {
        if (!_receive(token, currency, amount)) return;
        _holdOver(token, currency, amount, accruedSince);
        _attempt(token, currency);
    }

    /// @inheritdoc IFeeConsolidator
    /// @dev Reverts with the route's reason on failure, so the caller learns why.
    function retry(address token, address currency)
        external
        nonReentrant
        returns (uint256 settlementOut)
    {
        return _retry(token, currency, _held[token][currency]);
    }

    /// @notice Like `retry` but consolidates only `amount` (for balances too large for the pool).
    function retryAmount(address token, address currency, uint256 amount)
        external
        nonReentrant
        returns (uint256 settlementOut)
    {
        return _retry(token, currency, amount);
    }

    /// @inheritdoc IFeeConsolidator
    function heldFees(address token, address currency) external view returns (uint256) {
        return _held[token][currency];
    }

    /// @inheritdoc IFeeConsolidator
    function heldFeesIn(address token, address currency, uint256 epoch)
        external
        view
        returns (uint256)
    {
        return _heldIn[token][currency][epoch];
    }

    /// @notice Executes a route. Callable by this contract only, so failures can be caught.
    function execute(address token, address currency, uint256 amount)
        external
        onlySelf
        returns (uint256)
    {
        return _execute(token, currency, amount);
    }

    /// @dev Checks a delivery and books it as owed. Returns false for a zero amount.
    function _receive(address token, address currency, uint256 amount) private returns (bool) {
        if (!isSource[msg.sender]) revert NotAuthorized();
        address quote = quoteOf[token];
        if (quote == address(0)) revert UnknownToken(token);
        if (currency != token && currency != quote) revert InvalidCurrency(token, currency);
        if (amount == 0) return false;

        uint256 owed = totalHeld[currency] + amount;
        totalHeld[currency] = owed;
        // Never account for what was not delivered.
        uint256 balance = IERC20(currency).balanceOf(address(this));
        if (balance < owed) revert UnbackedDeposit(currency, balance, owed);
        return true;
    }

    /// @dev Adds `amount` to the held balance, tagged with accrual `epoch`.
    function _hold(address token, address currency, uint256 epoch, uint256 amount) private {
        if (amount == 0) return;
        uint256 held = _held[token][currency];
        if (held == 0 || epoch < _firstHeldEpoch[token][currency]) {
            _firstHeldEpoch[token][currency] = epoch;
        }
        _held[token][currency] = held + amount;
        _heldIn[token][currency][epoch] += amount;
    }

    /// @dev Spreads `amount`, earned evenly over `[since, now]`, across the epochs of that
    ///      interval by the time each covers. The oldest epoch takes the rounding remainder.
    function _holdOver(address token, address currency, uint256 amount, uint256 since) private {
        uint256 current = governor.currentEpoch();
        uint256 oldest = current >= MAX_ACCRUAL_EPOCHS ? current - (MAX_ACCRUAL_EPOCHS - 1) : 0;
        uint256 floor = governor.epochStart(oldest);
        if (since < floor) since = floor;
        if (since >= block.timestamp) {
            _hold(token, currency, current, amount);
            return;
        }

        uint256 total = block.timestamp - since;
        uint256 remaining = amount;
        uint256 end = block.timestamp;
        for (uint256 epoch = current;; --epoch) {
            uint256 start = governor.epochStart(epoch);
            if (start > end) start = end;
            if (start <= since || epoch == oldest) {
                _hold(token, currency, epoch, remaining);
                return;
            }
            uint256 part = FullMath.mulDiv(amount, end - start, total);
            _hold(token, currency, epoch, part);
            remaining -= part;
            end = start;
        }
    }

    /// @dev Takes `amount` from the held balance, oldest accrual epoch first, and returns the
    ///      parts taken with their epochs (`count` entries are used).
    function _release(address token, address currency, uint256 amount)
        private
        returns (uint256[] memory epochs, uint256[] memory parts, uint256 count)
    {
        _held[token][currency] -= amount;
        totalHeld[currency] -= amount;

        uint256 epoch = _firstHeldEpoch[token][currency];
        uint256 current = governor.currentEpoch();
        // Every tag is at most the current epoch, so this many slots always suffice.
        epochs = new uint256[](current - epoch + 1);
        parts = new uint256[](current - epoch + 1);
        uint256 remaining = amount;
        while (remaining != 0) {
            uint256 bucket = _heldIn[token][currency][epoch];
            if (bucket != 0) {
                uint256 take = bucket < remaining ? bucket : remaining;
                _heldIn[token][currency][epoch] = bucket - take;
                epochs[count] = epoch;
                parts[count] = take;
                ++count;
                remaining -= take;
                if (take < bucket) break;
            }
            ++epoch;
        }
        _firstHeldEpoch[token][currency] = epoch;
    }

    function _retry(address token, address currency, uint256 amount) private returns (uint256) {
        uint256 held = _held[token][currency];
        if (held == 0 || amount == 0) revert NothingToConsolidate(token, currency);
        if (amount > held) revert AmountExceedsHeld(amount, held);
        if (poolManager.isUnlocked()) revert PoolManagerBusy();
        return _execute(token, currency, amount);
    }

    function _attempt(address token, address currency) private {
        uint256 amount = _held[token][currency];
        if (amount == 0) return;
        if (poolManager.isUnlocked()) {
            // Inside a pool manager flow (the hook during a swap): hold and settle later.
            emit ConsolidationFailed(
                token, currency, amount, abi.encodeWithSelector(PoolManagerBusy.selector)
            );
            return;
        }
        try this.execute(token, currency, amount) returns (uint256) {}
        catch (bytes memory reason) {
            emit ConsolidationFailed(token, currency, amount, reason);
        }
    }

    function _execute(address token, address currency, uint256 amount)
        private
        returns (uint256 out)
    {
        (uint256[] memory epochs, uint256[] memory parts, uint256 count) =
            _release(token, currency, amount);

        // `currency` is the token or its quote asset, never the settlement asset itself.
        bytes memory result = poolManager.unlock(abi.encode(token, currency, amount));
        out = abi.decode(result, (uint256));
        if (out == 0) revert SlippageTooHigh(0, 1);

        IERC20(settlementAsset).safeTransfer(address(vault), out);
        // Each accrual epoch gets the output share of its input; the last takes the remainder.
        uint256 left = out;
        for (uint256 i; i < count; ++i) {
            uint256 share = i + 1 == count ? left : FullMath.mulDiv(out, parts[i], amount);
            left -= share;
            vault.depositFees(token, share, epochs[i]);
        }
        emit FeesConsolidated(token, currency, amount, out);
    }

    // ------------------------------------------------------------------ unlock callback

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAuthorized();
        (address token, address currencyIn, uint256 amountIn) =
            abi.decode(data, (address, address, uint256));

        PoolKey[] memory route = _routeFor(token, currencyIn);
        bool tokenHop = currencyIn == token;

        // Pay the input into the pool manager.
        poolManager.sync(Currency.wrap(currencyIn));
        IERC20(currencyIn).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();

        address current = currencyIn;
        uint256 amount = amountIn;
        for (uint256 i; i < route.length; ++i) {
            (current, amount) = _hop(route[i], current, amount, token, tokenHop && i == 0);
        }
        if (current != settlementAsset) revert NoRoute(currencyIn);

        poolManager.take(Currency.wrap(current), address(this), amount);
        return abi.encode(amount);
    }

    function _routeFor(address token, address currency)
        private
        view
        returns (PoolKey[] memory route)
    {
        address quote = quoteOf[token];
        PoolKey[] memory quoteRoute = quoteRegistry.routeOf(quote);
        if (quoteRoute.length == 0) revert NoRoute(quote);
        if (currency == quote) return quoteRoute;
        if (currency != token) revert InvalidCurrency(token, currency);

        route = new PoolKey[](quoteRoute.length + 1);
        route[0] = _poolKeys[token];
        for (uint256 i; i < quoteRoute.length; ++i) {
            route[i + 1] = quoteRoute[i];
        }
    }

    /// @dev Swaps `amount` of `current` exact-input through `key`, applying the price guards.
    function _hop(PoolKey memory key, address current, uint256 amount, address token, bool tokenHop)
        private
        returns (address next, uint256 out)
    {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);

        // WETH to a native ETH pool: unwrap inside the unlock.
        if (current == weth && c0 != weth && c1 != weth) {
            poolManager.take(Currency.wrap(weth), address(this), amount);
            IWETH(weth).withdraw(amount);
            poolManager.settle{value: amount}();
            current = address(0);
        }

        bool zeroForOne = current == c0;
        if (!zeroForOne && current != c1) revert NoRoute(current);

        PoolId id = key.toId();
        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = poolManager.getSlot0(id);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);

        _checkDeviation(key, id, tick, token, tokenHop);

        uint256 tolerance = maxSlippageBps + _hopFeeBps(key, lpFee, token, tokenHop);
        uint256 expected = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
        uint256 minOut = (expected * (BPS - tolerance)) / BPS;

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (spent >= 0 || uint256(uint128(-spent)) != amount) {
            revert PartialFill(spent >= 0 ? 0 : uint256(uint128(-spent)), amount);
        }
        out = received > 0 ? uint256(uint128(received)) : 0;
        if (out < minOut) revert SlippageTooHigh(out, minOut);

        if (!tokenHop) _moveReference(id, tick);
        next = zeroForOne ? c1 : c0;
    }

    function _checkDeviation(
        PoolKey memory key,
        PoolId id,
        int24 spotTick,
        address token,
        bool tokenHop
    ) private view {
        int24 referenceTick;
        if (tokenHop) {
            (bool ok, int24 twap,) = IHookOracle(address(key.hooks)).twapTick(token, TWAP_WINDOW);
            if (!ok) revert OracleUnavailable(token);
            referenceTick = twap;
        } else {
            Reference memory ref = references[id];
            if (!ref.set) revert ReferenceNotSet(id);
            referenceTick = ref.tick;
        }
        int256 diff = int256(spotTick) - int256(referenceTick);
        if (uint256(diff < 0 ? -diff : diff) > maxDeviationTicks) {
            revert PriceDeviation(spotTick, referenceTick);
        }
    }

    /// @dev Moves the reference toward spot by the elapsed fraction of `REFERENCE_WINDOW`, with
    ///      each step capped at a tenth of `maxDeviationTicks` (at least one tick) and the result
    ///      clamped to the anchor band. The band is `maxDriftTicks` at the anchor and widens by
    ///      `maxDriftTicks` per `ANCHOR_WIDENING_PERIOD`, so repeated manipulation can walk the
    ///      reference from the anchor at that rate at most, while a sustained market trend no
    ///      faster than that is followed without the owner.
    ///      A step that rounds to zero keeps the elapsed time, so frequent hops still add up.
    function _moveReference(PoolId id, int24 spotTick) private {
        Reference storage ref = references[id];
        int256 diff = int256(spotTick) - int256(ref.tick);
        if (diff == 0) {
            // Already at spot: nothing is owed for the elapsed time.
            ref.updatedAt = uint40(block.timestamp);
            return;
        }
        uint256 dt = block.timestamp - ref.updatedAt;
        if (dt > REFERENCE_WINDOW) dt = REFERENCE_WINDOW;
        int256 step = (diff * int256(dt)) / int256(REFERENCE_WINDOW);
        if (step == 0) return;
        uint256 capTicks = maxDeviationTicks / 10;
        if (capTicks == 0) capTicks = 1;
        if (capTicks > MAX_ANCHOR_BAND) capTicks = MAX_ANCHOR_BAND;
        int256 cap = int256(capTicks);
        if (step > cap) step = cap;
        if (step < -cap) step = -cap;

        int256 band = int256(_anchorBand(ref.anchoredAt));
        int256 next = int256(ref.tick) + step;
        int256 lo = int256(ref.anchor) - band;
        int256 hi = int256(ref.anchor) + band;
        if (lo < TickMath.MIN_TICK) lo = TickMath.MIN_TICK;
        if (hi > TickMath.MAX_TICK) hi = TickMath.MAX_TICK;
        if (next < lo) next = lo;
        if (next > hi) next = hi;
        ref.tick = int24(next);
        ref.updatedAt = uint40(block.timestamp);
    }

    /// @dev Current half width of the anchor band of a reference anchored at `anchoredAt`.
    function _anchorBand(uint40 anchoredAt) private view returns (uint256 band) {
        uint256 drift = maxDriftTicks;
        if (drift >= MAX_ANCHOR_BAND) return MAX_ANCHOR_BAND;
        band = drift + (drift * (block.timestamp - anchoredAt)) / ANCHOR_WIDENING_PERIOD;
        if (band > MAX_ANCHOR_BAND) band = MAX_ANCHOR_BAND;
    }

    /// @notice Half width of the band around the anchor that the reference of `key` may use now.
    function anchorBandOf(PoolKey calldata key) external view returns (uint256) {
        Reference memory ref = references[key.toId()];
        if (!ref.set) revert ReferenceNotSet(key.toId());
        return _anchorBand(ref.anchoredAt);
    }

    /// @dev Pool fee of a hop in basis points, rounded up.
    function _hopFeeBps(PoolKey memory key, uint24 lpFee, address token, bool tokenHop)
        private
        view
        returns (uint256 feeBps)
    {
        if (tokenHop) {
            // The token pool uses an overridden dynamic fee equal to the token's base fee.
            feeBps = IVeradaHook(address(key.hooks)).feeConfig(token).baseFeeBps;
        } else {
            uint256 pips = LPFeeLibrary.isDynamicFee(key.fee) ? lpFee : key.fee;
            feeBps = (pips + 99) / 100;
        }
        if (feeBps > MAX_HOP_FEE_BPS) revert HopFeeTooHigh(feeBps);
    }
}
