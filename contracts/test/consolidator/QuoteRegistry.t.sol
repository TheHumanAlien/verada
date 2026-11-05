// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {MockERC20, MockOndoToken, MockWETH} from "./ConsolidatorMocks.sol";

contract QuoteRegistryTest is Test {
    QuoteRegistry registry;
    MockERC20 usdc;
    MockWETH weth;
    MockOndoToken ondo;
    MockOndoToken ondo2;

    address owner = makeAddr("owner");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockWETH();
        ondo = new MockOndoToken("AAPLon");
        ondo2 = new MockOndoToken("MSFTon");
        registry = new QuoteRegistry(owner, address(usdc), address(weth));
    }

    function _key(address a, address b, uint24 fee) internal pure returns (PoolKey memory k) {
        (a, b) = a < b ? (a, b) : (b, a);
        k = PoolKey(Currency.wrap(a), Currency.wrap(b), fee, 60, IHooks(address(0)));
    }

    function _route1(address asset) internal view returns (PoolKey[] memory r) {
        r = new PoolKey[](1);
        r[0] = _key(asset, address(usdc), 3000);
    }

    // ------------------------------------------------------------------ allowlist

    function test_constructorRejectsZero() public {
        vm.expectRevert(IQuoteRegistry.ZeroAddress.selector);
        new QuoteRegistry(owner, address(0), address(weth));
        vm.expectRevert(IQuoteRegistry.ZeroAddress.selector);
        new QuoteRegistry(owner, address(usdc), address(0));
    }

    function test_addReadsDecimalsAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit IQuoteRegistry.QuoteAssetAdded(address(ondo), 18, IQuoteRegistry.Kind.Ondo);
        vm.prank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);

        IQuoteRegistry.QuoteAsset memory a = registry.getQuoteAsset(address(ondo));
        assertEq(a.decimals, 18);
        assertEq(uint8(a.kind), uint8(IQuoteRegistry.Kind.Ondo));
        assertTrue(a.active);
        assertTrue(registry.isAllowed(address(ondo)));
    }

    function test_unknownAssetNotAllowed() public view {
        assertFalse(registry.isAllowed(address(ondo)));
        IQuoteRegistry.QuoteAsset memory a = registry.getQuoteAsset(address(ondo));
        assertEq(a.decimals, 0);
        assertFalse(a.active);
    }

    function test_onlyOwnerManages() public {
        vm.expectRevert();
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.startPrank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.stopPrank();
        vm.expectRevert();
        registry.deactivateQuoteAsset(address(ondo));
        vm.expectRevert();
        registry.reactivateQuoteAsset(address(ondo));
        vm.expectRevert();
        registry.setRoute(address(ondo), _route1(address(ondo)));
    }

    function test_duplicateZeroAndSettlementRejected() public {
        vm.startPrank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.expectRevert(
            abi.encodeWithSelector(IQuoteRegistry.QuoteAssetAlreadyExists.selector, address(ondo))
        );
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.expectRevert(IQuoteRegistry.ZeroAddress.selector);
        registry.addQuoteAsset(address(0), IQuoteRegistry.Kind.Native);
        vm.expectRevert(QuoteRegistry.AssetIsSettlement.selector);
        registry.addQuoteAsset(address(usdc), IQuoteRegistry.Kind.Native);
        vm.stopPrank();
    }

    function test_deactivateReactivate() public {
        vm.startPrank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.expectEmit(true, false, false, false);
        emit IQuoteRegistry.QuoteAssetDeactivated(address(ondo));
        registry.deactivateQuoteAsset(address(ondo));
        assertFalse(registry.isAllowed(address(ondo)));
        // Decimals and kind are kept.
        assertEq(registry.getQuoteAsset(address(ondo)).decimals, 18);
        vm.expectEmit(true, false, false, false);
        emit IQuoteRegistry.QuoteAssetReactivated(address(ondo));
        registry.reactivateQuoteAsset(address(ondo));
        assertTrue(registry.isAllowed(address(ondo)));
        vm.stopPrank();
    }

    function test_unknownAssetCannotToggle() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IQuoteRegistry.QuoteAssetNotFound.selector, address(ondo))
        );
        registry.deactivateQuoteAsset(address(ondo));
        vm.expectRevert(
            abi.encodeWithSelector(IQuoteRegistry.QuoteAssetNotFound.selector, address(ondo))
        );
        registry.reactivateQuoteAsset(address(ondo));
        vm.expectRevert(
            abi.encodeWithSelector(IQuoteRegistry.QuoteAssetNotFound.selector, address(ondo))
        );
        registry.setRoute(address(ondo), _route1(address(ondo)));
        vm.stopPrank();
    }

    function test_enumerationInsertionOrder() public {
        vm.startPrank(owner);
        registry.addQuoteAsset(address(weth), IQuoteRegistry.Kind.Native);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        registry.addQuoteAsset(address(ondo2), IQuoteRegistry.Kind.Ondo);
        registry.deactivateQuoteAsset(address(ondo));
        vm.stopPrank();
        assertEq(registry.quoteAssetCount(), 3);
        assertEq(registry.quoteAssetAt(0), address(weth));
        assertEq(registry.quoteAssetAt(1), address(ondo));
        assertEq(registry.quoteAssetAt(2), address(ondo2));
    }

    function test_nonTokenAddressRejected() public {
        vm.prank(owner);
        vm.expectRevert();
        registry.addQuoteAsset(makeAddr("eoa"), IQuoteRegistry.Kind.Ondo);
    }

    // ------------------------------------------------------------------ routes

    function test_addWithRoute() public {
        vm.prank(owner);
        registry.addQuoteAssetWithRoute(
            address(ondo), IQuoteRegistry.Kind.Ondo, _route1(address(ondo))
        );
        assertTrue(registry.hasRoute(address(ondo)));
        assertEq(registry.routeLength(address(ondo)), 1);
        PoolKey[] memory r = registry.routeOf(address(ondo));
        assertEq(r.length, 1);
        assertEq(r[0].fee, 3000);
    }

    function test_noRouteByDefault() public {
        vm.prank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        assertFalse(registry.hasRoute(address(ondo)));
        assertEq(registry.routeOf(address(ondo)).length, 0);
    }

    function test_setRouteReplaces() public {
        vm.startPrank(owner);
        registry.addQuoteAssetWithRoute(
            address(ondo), IQuoteRegistry.Kind.Ondo, _route1(address(ondo))
        );
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = _key(address(ondo), address(usdc), 500);
        registry.setRoute(address(ondo), r);
        vm.stopPrank();
        assertEq(registry.routeOf(address(ondo))[0].fee, 500);
        assertEq(registry.routeLength(address(ondo)), 1);
    }

    function test_multiHopRoute() public {
        // ondo -> weth -> usdc
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = _key(address(ondo), address(weth), 3000);
        r[1] = _key(address(weth), address(usdc), 500);
        vm.prank(owner);
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
        assertEq(registry.routeLength(address(ondo)), 2);
    }

    function test_routeMustSettleInUsdc() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = _key(address(ondo), address(ondo2), 3000);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(QuoteRegistry.RouteDoesNotSettle.selector, address(ondo2))
        );
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
    }

    function test_routeMustBeConnected() public {
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = _key(address(ondo), address(weth), 3000);
        r[1] = _key(address(ondo2), address(usdc), 500); // does not contain weth
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDisconnected.selector, 1));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
    }

    function test_routeLengthBounds() public {
        PoolKey[] memory empty = new PoolKey[](0);
        vm.startPrank(owner);
        registry.addQuoteAsset(address(ondo), IQuoteRegistry.Kind.Ondo);
        vm.expectRevert(QuoteRegistry.EmptyRoute.selector);
        registry.setRoute(address(ondo), empty);
        PoolKey[] memory long = new PoolKey[](4);
        for (uint256 i; i < 4; ++i) {
            long[i] = _key(address(ondo), address(usdc), uint24(100 + i));
        }
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteTooLong.selector, 4));
        registry.setRoute(address(ondo), long);
        vm.stopPrank();
    }

    function test_wethToNativePoolRouteAllowed() public {
        // weth -> (native ETH / usdc pool): the consolidator unwraps between the asset and pool.
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 10, IHooks(address(0))
        );
        vm.prank(owner);
        registry.addQuoteAssetWithRoute(address(weth), IQuoteRegistry.Kind.Native, r);
        assertTrue(registry.hasRoute(address(weth)));
    }

    function test_nativePoolNotReachableFromOtherAssets() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 10, IHooks(address(0))
        );
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDisconnected.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
    }

    function test_failedRouteDoesNotAddAsset() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = _key(address(ondo), address(ondo2), 3000);
        vm.prank(owner);
        vm.expectRevert();
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
        assertEq(registry.quoteAssetCount(), 0);
        assertFalse(registry.isAllowed(address(ondo)));
    }

    function test_deactivatedAssetKeepsRoute() public {
        vm.startPrank(owner);
        registry.addQuoteAssetWithRoute(
            address(ondo), IQuoteRegistry.Kind.Ondo, _route1(address(ondo))
        );
        registry.deactivateQuoteAsset(address(ondo));
        vm.stopPrank();
        assertTrue(registry.hasRoute(address(ondo)));
    }

    function testFuzz_decimalsRecorded(uint8 dec) public {
        dec = uint8(bound(dec, 1, 36));
        MockERC20 t = new MockERC20("X", dec);
        vm.prank(owner);
        registry.addQuoteAsset(address(t), IQuoteRegistry.Kind.Ondo);
        assertEq(registry.getQuoteAsset(address(t)).decimals, dec);
    }

    function test_invalidDecimalsRejected() public {
        MockERC20 t = new MockERC20("X", 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.InvalidDecimals.selector, address(t)));
        registry.addQuoteAsset(address(t), IQuoteRegistry.Kind.Ondo);
    }

    function test_ownershipTwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner);
        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);
    }
}
