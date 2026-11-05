// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {MockFeeConsolidator, MockPositionManager, VaultTestToken} from "./VaultMocks.sol";
import {Test} from "forge-std/Test.sol";

/// @dev The locker reports the interval over which collected LP fees were earned, so the
///      consolidator can attribute them to those epochs rather than to the collection epoch.
contract LpLockerAccrualTest is Test {
    MockFeeConsolidator cons;
    VeradaLpLocker locker;
    MockPositionManager pm;
    VaultTestToken weth;
    VaultTestToken meme;

    address factory = makeAddr("factory");

    function setUp() public {
        weth = new VaultTestToken("WETH");
        meme = new VaultTestToken("MEME");
        pm = new MockPositionManager(address(weth), address(meme));
        cons = new MockFeeConsolidator();
        locker = new VeradaLpLocker(address(pm), IFeeConsolidator(address(cons)), factory);
    }

    function _accrue(uint256 id, uint256 a0, uint256 a1) internal {
        weth.mint(address(pm), a0);
        meme.mint(address(pm), a1);
        pm.accrue(id, a0, a1);
    }

    function test_collectReportsAccrualSinceLastCollection() public {
        uint256 t0 = 50 days;
        vm.warp(t0);
        uint256 id = pm.mintTo(address(locker), 1e18);
        vm.prank(factory);
        locker.lock(address(meme), id);
        assertEq(locker.lastCollectedAt(address(meme)), t0);

        vm.warp(t0 + 5 days);
        _accrue(id, 100, 200);
        vm.prank(address(0xBEEF));
        locker.collectFees(address(meme));
        assertEq(cons.accruedCalls(), 2, "both currencies carry their interval");
        assertEq(cons.lastAccruedSince(), t0, "earned since the lock");
        assertEq(locker.lastCollectedAt(address(meme)), t0 + 5 days);

        vm.warp(t0 + 30 days);
        _accrue(id, 7, 0);
        locker.collectFees(address(meme));
        assertEq(cons.accruedCalls(), 3);
        assertEq(cons.lastAccruedSince(), t0 + 5 days, "earned since the previous collection");
        assertEq(locker.lastCollectedAt(address(meme)), t0 + 30 days);
        assertEq(cons.delivered(address(meme), address(weth)), 107);
        assertEq(cons.delivered(address(meme), address(meme)), 200);
    }

    function test_emptyCollectionStillAdvancesInterval() public {
        uint256 id = pm.mintTo(address(locker), 1);
        vm.prank(factory);
        locker.lock(address(meme), id);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        locker.collectFees(address(meme));
        assertEq(cons.accruedCalls(), 0);
        assertEq(locker.lastCollectedAt(address(meme)), vm.getBlockTimestamp());
    }
}
