// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {MockFeeConsolidator, MockPositionManager, VaultTestToken} from "./VaultMocks.sol";
import {Test} from "forge-std/Test.sol";

contract VeradaLpLockerTest is Test {
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

    function _lock(uint256 liq) internal returns (uint256 id) {
        id = pm.mintTo(address(locker), liq);
        vm.prank(factory);
        locker.lock(address(meme), id);
    }

    function test_lockRecordsPosition() public {
        uint256 id = _lock(1e18);
        assertEq(locker.lpTokenIdOf(address(meme)), id);
        assertEq(pm.ownerOf(id), address(locker));
    }

    function test_lockOnlyFactory() public {
        uint256 id = pm.mintTo(address(locker), 1);
        vm.expectRevert(ILpLocker.NotFactory.selector);
        locker.lock(address(meme), id);
    }

    function test_lockRequiresCustody() public {
        uint256 id = pm.mintTo(address(this), 1);
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(VeradaLpLocker.NotPositionOwner.selector, id));
        locker.lock(address(meme), id);
    }

    function test_lockTwiceReverts() public {
        _lock(1);
        uint256 id2 = pm.mintTo(address(locker), 1);
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(ILpLocker.AlreadyLocked.selector, address(meme)));
        locker.lock(address(meme), id2);
    }

    function test_lpTokenIdOfUnlockedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ILpLocker.NotLocked.selector, address(5)));
        locker.lpTokenIdOf(address(5));
    }

    function test_collectFeesForwardsRawFeesToConsolidator() public {
        uint256 id = _lock(1e18);
        weth.mint(address(pm), 1000);
        meme.mint(address(pm), 5000);
        pm.accrue(id, 1000, 5000);

        vm.prank(address(0xBEEF)); // permissionless
        (uint256 a0, uint256 a1) = locker.collectFees(address(meme));
        assertEq(a0, 1000);
        assertEq(a1, 5000);
        assertEq(weth.balanceOf(address(cons)), 1000);
        assertEq(meme.balanceOf(address(cons)), 5000);
        assertEq(weth.balanceOf(address(locker)), 0);
        assertEq(meme.balanceOf(address(locker)), 0);
        assertEq(cons.delivered(address(meme), address(weth)), 1000);
        assertEq(cons.delivered(address(meme), address(meme)), 5000);
    }

    function test_collectFeesNeverTouchesPrincipal() public {
        uint256 id = _lock(7e18);
        weth.mint(address(pm), 10);
        pm.accrue(id, 10, 0);
        locker.collectFees(address(meme));
        assertEq(pm.liquidity(id), 7e18);
        assertEq(pm.ownerOf(id), address(locker));
    }

    function test_collectFeesNothingAccrued() public {
        _lock(1);
        (uint256 a0, uint256 a1) = locker.collectFees(address(meme));
        assertEq(a0 + a1, 0);
    }

    function test_collectFeesUnlockedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ILpLocker.NotLocked.selector, address(5)));
        locker.collectFees(address(5));
    }

    function test_rejectsForeignNftReceipt() public {
        vm.expectRevert(VeradaLpLocker.UnexpectedNft.selector);
        locker.onERC721Received(address(0), address(0), 1, "");
    }

    function test_noPrincipalWithdrawSurface() public {
        // The locker exposes no transfer/withdraw/decrease entry point: probe common selectors.
        bytes4[6] memory sels = [
            bytes4(keccak256("withdraw(uint256)")),
            bytes4(keccak256("withdraw(address,uint256)")),
            bytes4(keccak256("unlock(address)")),
            bytes4(keccak256("transferNft(address,uint256)")),
            bytes4(keccak256("decreaseLiquidity(address,uint256)")),
            bytes4(keccak256("rescue(address,address,uint256)"))
        ];
        _lock(1);
        for (uint256 i; i < sels.length; ++i) {
            (bool ok,) = address(locker).call(abi.encodeWithSelector(sels[i], address(meme), 1));
            assertFalse(ok);
        }
        assertEq(pm.ownerOf(1), address(locker));
    }

    function testFuzz_collectConservesValue(uint96 f0, uint96 f1) public {
        uint256 id = _lock(1e18);
        weth.mint(address(pm), f0);
        meme.mint(address(pm), f1);
        pm.accrue(id, f0, f1);
        locker.collectFees(address(meme));
        assertEq(weth.balanceOf(address(cons)), f0);
        assertEq(meme.balanceOf(address(cons)), f1);
        assertEq(cons.delivered(address(meme), address(weth)), f0);
        assertEq(cons.delivered(address(meme), address(meme)), f1);
    }

    function test_collectRevertsIfConsolidatorRefusesDelivery() public {
        uint256 id = _lock(1e18);
        weth.mint(address(pm), 10);
        pm.accrue(id, 10, 0);
        cons.setFailing(true);
        vm.expectRevert("consolidator down");
        locker.collectFees(address(meme));
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(VeradaLpLocker.ZeroAddress.selector);
        new VeradaLpLocker(address(pm), IFeeConsolidator(address(0)), factory);
    }
}
