// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";

import {ConsolidatorBase} from "./ConsolidatorBase.sol";
import {MockERC20} from "./ConsolidatorMocks.sol";

/// @dev Random deliveries, retries, pauses, trades and time travel against the real pool
///      manager. Whatever the guards decide, raw fees are either still held (and fully backed by
///      the contract balance) or have become USDC credited to the vault; nothing leaks.
contract ConsolidatorInvariantTest is ConsolidatorBase {
    uint256 internal deliveredQuote;
    uint256 internal deliveredMeme;
    uint256 internal lastVaultTracked;
    uint256 internal monotonicViolations;
    uint256 internal flushReportViolations;

    function setUp() public {
        _baseSetUp();
        _setupPools(3000, 1 days);
        skip(2000);

        targetContract(address(this));
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = this.h_deliverQuote.selector;
        sels[1] = this.h_deliverMeme.selector;
        sels[2] = this.h_retry.selector;
        sels[3] = this.h_retryPartial.selector;
        sels[4] = this.h_setPaused.selector;
        sels[5] = this.h_trade.selector;
        sels[6] = this.h_warp.selector;
        sels[7] = this.h_reseed.selector;
        sels[8] = this.h_advanceEpoch.selector;
        sels[9] = this.h_deliverAccrued.selector;
        sels[10] = this.h_flushThrough.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: sels}));
    }

    // ------------------------------------------------------------------ handlers

    function _afterAction() internal {
        uint256 tracked = vault.totalTracked();
        if (tracked < lastVaultTracked) monotonicViolations++;
        lastVaultTracked = tracked;
    }

    function h_deliverQuote(uint96 amount) external {
        uint256 a = (uint256(amount) % 5e21) + 1;
        deliveredQuote += a;
        _deliver(address(quote), a);
        _afterAction();
    }

    function h_deliverMeme(uint96 amount) external {
        uint256 a = (uint256(amount) % 5e21) + 1;
        deliveredMeme += a;
        _deliver(address(meme), a);
        _afterAction();
    }

    /// LP-like delivery spread over past epochs (exercises parts tagged below the newest).
    function h_deliverAccrued(bool memeSide, uint96 amount, uint32 age) external {
        uint256 a = (uint256(amount) % 5e21) + 1;
        address c = memeSide ? address(meme) : address(quote);
        if (memeSide) deliveredMeme += a;
        else deliveredQuote += a;
        MockERC20(c).mint(address(cons), a);
        uint256 since = vm.getBlockTimestamp() - (uint256(age) % vm.getBlockTimestamp());
        vm.prank(locker);
        cons.consolidateAccrued(address(meme), c, a, since);
        _afterAction();
    }

    function h_flushThrough(uint8 back) external {
        uint256 current = governor.currentEpoch();
        uint256 e = current - (uint256(back) % (current + 1));
        bool clear = cons.flushThrough(address(meme), e);
        bool held = cons.heldThrough(address(meme), address(meme), e)
            || cons.heldThrough(address(meme), address(quote), e);
        if (clear == held) flushReportViolations++;
        _afterAction();
    }

    function h_retry(bool memeSide) external {
        address c = memeSide ? address(meme) : address(quote);
        try cons.retry(address(meme), c) {} catch {}
        _afterAction();
    }

    function h_retryPartial(bool memeSide, uint96 amount) external {
        address c = memeSide ? address(meme) : address(quote);
        uint256 held = cons.heldFees(address(meme), c);
        if (held != 0) {
            try cons.retryAmount(address(meme), c, (uint256(amount) % held) + 1) {} catch {}
        }
        _afterAction();
    }

    function h_setPaused(bool p) external {
        quote.setPaused(p);
    }

    function h_trade(bool inQuotePool, bool zeroForOne, uint96 amount) external {
        uint256 a = (uint256(amount) % (inQuotePool ? 3e22 : 1e24)) + 1e6;
        PoolKey memory k = inQuotePool ? quoteKey : tokenKey;
        // The pool may be paused or exhausted: failed trades are simply skipped.
        try this.trade(k, zeroForOne, a) {} catch {}
    }

    function trade(PoolKey calldata k, bool zeroForOne, uint256 a) external {
        require(msg.sender == address(this));
        swap(k, zeroForOne, -int256(a), ZERO_BYTES);
    }

    function h_warp(uint32 secs) external {
        skip(uint256(secs) % 4 hours);
    }

    function h_advanceEpoch() external {
        governor.setCurrentEpoch(governor.currentEpoch() + 1);
    }

    function h_reseed() external {
        PoolKey[] memory ks = new PoolKey[](1);
        ks[0] = quoteKey;
        cons.seedReferences(ks);
    }

    // ------------------------------------------------------------------ invariants

    /// The contract balance of each raw asset is exactly what is recorded as held.
    function invariant_rawBalancesEqualHeld() public view {
        assertEq(meme.balanceOf(address(cons)), cons.totalHeld(address(meme)));
        assertEq(quote.balanceOf(address(cons)), cons.totalHeld(address(quote)));
        assertEq(cons.heldFees(address(meme), address(meme)), cons.totalHeld(address(meme)));
        assertEq(cons.heldFees(address(meme), address(quote)), cons.totalHeld(address(quote)));
    }

    /// Held fees are fully tagged with accrual epochs, none of them in the future.
    function invariant_heldPartsSumToHeld() public view {
        uint256 current = governor.currentEpoch();
        address[2] memory cs = [address(meme), address(quote)];
        for (uint256 c; c < 2; ++c) {
            uint256 sum;
            for (uint256 e; e <= current; ++e) {
                sum += cons.heldFeesIn(address(meme), cs[c], e);
            }
            assertEq(sum, cons.heldFees(address(meme), cs[c]));
            assertEq(cons.heldFeesIn(address(meme), cs[c], current + 1), 0);
        }
    }

    /// `heldThrough` agrees with the epoch parts, and `flushThrough` reported what it left.
    function invariant_heldThroughMatchesParts() public view {
        uint256 current = governor.currentEpoch();
        address[2] memory cs = [address(meme), address(quote)];
        for (uint256 c; c < 2; ++c) {
            uint256 sum;
            for (uint256 e; e <= current; ++e) {
                sum += cons.heldFeesIn(address(meme), cs[c], e);
                assertEq(cons.heldThrough(address(meme), cs[c], e), sum != 0);
            }
        }
        assertEq(flushReportViolations, 0);
    }

    /// The vault cause pools per epoch add up to the token's cause pool.
    function invariant_epochPoolsSumToCausePool() public view {
        uint256 current = governor.currentEpoch();
        uint256 sum;
        for (uint256 e; e <= current; ++e) {
            sum += vault.causePoolOf(address(meme), e);
        }
        assertEq(sum, vault.causePool(address(meme)));
    }

    /// Nothing is stranded in the consolidator, the hook or as native ETH.
    function invariant_noStrandedFunds() public view {
        assertEq(usdc.balanceOf(address(cons)), 0);
        assertEq(address(cons).balance, 0);
        assertEq(meme.balanceOf(address(hook)), 0);
        assertEq(quote.balanceOf(address(hook)), 0);
        assertEq(usdc.balanceOf(address(hook)), 0);
        assertEq(weth.balanceOf(address(cons)), 0);
    }

    /// Everything consolidated is in the vault, split exactly 10 / 90, and never decreases.
    function invariant_usdcValueConserved() public view {
        uint256 bal = usdc.balanceOf(address(vault));
        assertEq(vault.totalTracked(), bal);
        assertEq(vault.platformAccrued() + vault.causePool(address(meme)), bal);
        (uint256 p,) = vault.split(bal);
        assertLe(vault.platformAccrued(), p + 1e6); // per-deposit rounding stays below 1 unit each
        assertEq(monotonicViolations, 0);
    }
}
