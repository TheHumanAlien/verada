// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PositionManager} from "v4-periphery/PositionManager.sol";
import {IPositionDescriptor} from "v4-periphery/interfaces/IPositionDescriptor.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IWETH9} from "v4-periphery/interfaces/external/IWETH9.sol";

import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {VeradaFactory} from "../src/VeradaFactory.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../src/interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaFactory} from "../src/interfaces/IVeradaFactory.sol";
import {IVeradaHook} from "../src/interfaces/IVeradaHook.sol";
import {LabelLib} from "../src/libraries/LabelLib.sol";
import {
    MockFeeVault,
    MockGovernor,
    MockHook,
    MockLocker,
    MockQuote,
    MockQuoteRegistry,
    MockWeth
} from "./mocks/FactoryMocks.sol";

contract VeradaFactoryTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant SUPPLY = 100_000_000_000e18;
    // beforeInitialize | beforeSwap
    uint160 internal constant HOOK_FLAGS = (1 << 13) | (1 << 7);
    // namehash("varada.eth")
    bytes32 internal constant PARENT_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;

    PoolManager internal poolManager;
    IPositionManager internal posm;
    MockWeth internal weth;
    MockLocker internal locker;
    MockFeeVault internal vault;
    MockGovernor internal governor;

    /// @dev Hunger x Africa.
    uint64 internal constant FOCUS_CATEGORIES = uint64(1) << 2;
    uint16 internal constant FOCUS_REGIONS = uint16(1);
    MockHook internal hook;
    MockQuoteRegistry internal registry;
    MockQuote internal usdcLike; // 6 decimals
    MockQuote internal ondo8; // 8 decimals
    MockQuote internal ondo18; // 18 decimals
    TokenProfileRegistry internal profiles;
    VeradaFactory internal factory;
    PoolSwapTest internal swapRouter;

    address internal creator = makeAddr("creator");

    event TokenCreated(
        address indexed token,
        address indexed creator,
        bytes32 pool,
        address hook,
        uint256 lpTokenId,
        uint24 feeBps,
        string metadataURI
    );

    function setUp() public {
        poolManager = new PoolManager(address(this));
        weth = new MockWeth();
        address permit2 = new DeployPermit2().deployPermit2();
        posm = IPositionManager(
            address(
                new PositionManager(
                    IPoolManager(address(poolManager)),
                    IAllowanceTransfer(permit2),
                    100_000,
                    IPositionDescriptor(address(0)),
                    IWETH9(address(weth))
                )
            )
        );
        locker = new MockLocker(address(posm));
        vault = new MockFeeVault();
        governor = new MockGovernor();
        swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));

        registry = new MockQuoteRegistry();
        usdcLike = new MockQuote("Q6", 6);
        ondo8 = new MockQuote("Q8", 8);
        ondo18 = new MockQuote("Q18", 18);
        registry.set(address(weth), 18, false, true);
        registry.set(address(usdcLike), 6, true, true);
        registry.set(address(ondo8), 8, true, true);
        registry.set(address(ondo18), 18, true, true);

        // The profile registry is deployed first (one nonce), then the factory.
        address predictedFactory =
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        profiles = new TokenProfileRegistry(address(this), predictedFactory, PARENT_NODE);
        address hookAddr = address(uint160(HOOK_FLAGS) | (uint160(0xBEEF) << 144));
        deployCodeTo("FactoryMocks.sol:MockHook", abi.encode(predictedFactory), hookAddr);
        hook = MockHook(hookAddr);

        factory = new VeradaFactory(
            IPoolManager(address(poolManager)),
            posm,
            IQuoteRegistry(address(registry)),
            IVeradaHook(hookAddr),
            ILpLocker(address(locker)),
            IFeeVault(address(vault)),
            IEpochGovernor(address(governor)),
            ITokenProfileRegistry(address(profiles))
        );
        assertEq(address(factory), predictedFactory);
        assertEq(profiles.factory(), address(factory));
        locker.init(address(factory));
        vault.init(address(factory));
        governor.init(address(factory));
    }

    // ------------------------------------------------------------------ helpers

    /// @dev A label unique per salt, so tests that launch several tokens never collide.
    function _label(bytes32 salt) internal pure returns (string memory) {
        return string.concat("frog-", vm.toString(uint256(salt) % 1e18));
    }

    function _params(bytes32 salt) internal view returns (IVeradaFactory.DeployParams memory p) {
        p = IVeradaFactory.DeployParams({
            name: "Verada Frog",
            symbol: "FROG",
            metadataURI: "ipfs://frog",
            salt: salt,
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: address(weth),
            label: _label(salt),
            logoRef: bytes32(0),
            categoryMask: FOCUS_CATEGORIES,
            regionMask: FOCUS_REGIONS
        });
    }

    /// @dev Finds a salt for which the token sorts as currency0 (or currency1) against WETH.
    function _paramsOrdered(bool tokenIsCurrency0, address who)
        internal
        view
        returns (IVeradaFactory.DeployParams memory p)
    {
        for (uint256 i; i < 64; ++i) {
            p = _params(bytes32(i));
            address predicted = factory.predictTokenAddress(who, p);
            if ((predicted < address(weth)) == tokenIsCurrency0) return p;
        }
        revert("no salt");
    }

    function _deploy(address who, IVeradaFactory.DeployParams memory p)
        internal
        returns (address token, uint256 id)
    {
        vm.prank(who);
        (token, id) = factory.deployToken(p);
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return _keyFor(token, address(weth));
    }

    function _keyFor(address token, address quote) internal view returns (PoolKey memory) {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0x800000, 200, IHooks(address(hook)));
    }

    function _assertLaunchInvariants(
        address token,
        uint256 id,
        IVeradaFactory.DeployParams memory p
    ) internal view {
        VeradaToken t = VeradaToken(token);
        // The factory keeps nothing and the whole (post-dust) supply sits in the pool manager.
        assertEq(t.balanceOf(address(factory)), 0, "factory balance");
        assertEq(t.balanceOf(address(poolManager)), t.totalSupply(), "pool holds supply");
        assertLe(SUPPLY - t.totalSupply(), SUPPLY / 1e9, "dust bounded");
        assertEq(weth.balanceOf(address(poolManager)), 0, "no weth in pool");

        // NFT in the locker, recorded, registered.
        assertEq(IERC721(address(posm)).ownerOf(id), address(locker));
        assertEq(locker.lpTokenIdOf(token), id);
        assertTrue(locker.locked(token));
        assertTrue(vault.registered(token));
        assertTrue(governor.registered(token));
        (uint64 cm, uint16 rm) = profiles.focusOf(token);
        assertEq(cm, FOCUS_CATEGORIES);
        assertEq(rm, FOCUS_REGIONS);
        assertTrue(factory.isVeradaToken(token));

        // Token metadata.
        assertEq(t.creator(), creator);
        assertEq(t.metadataURI(), p.metadataURI);

        // Profile.
        assertTrue(profiles.isRegistered(token));
        assertEq(profiles.controllerOf(token), creator);
        assertEq(profiles.labelOf(token), p.label);
        assertEq(profiles.logoRefOf(token), p.logoRef);
        assertEq(profiles.tokenByLabelhash(keccak256(bytes(p.label))), token);

        // Hook config.
        IVeradaHook.FeeConfig memory cfg = IVeradaHook(address(hook)).feeConfig(token);
        assertEq(cfg.baseFeeBps, p.baseFeeBps);
        assertEq(cfg.sniperFeeStartBps, p.sniperFeeStartBps);
        assertEq(cfg.sniperDecaySeconds, p.sniperDecaySeconds);
        assertEq(cfg.launchTimestamp, block.timestamp);

        // Pool state.
        PoolKey memory key = _key(token);
        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) =
            IPoolManager(address(poolManager)).getSlot0(key.toId());
        bool isC0 = Currency.unwrap(key.currency0) == token;
        int24 expectedTick = isC0 ? p.startTick : -p.startTick;
        assertEq(tick, expectedTick, "start tick");
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(expectedTick));
        lpFee; // dynamic pools start at fee 0 until the hook overrides per swap
        assertGt(posm.getPositionLiquidity(id), 0);
    }

    // ------------------------------------------------------------------ deploy

    function test_deployToken_currency0() public {
        IVeradaFactory.DeployParams memory p = _paramsOrdered(true, creator);
        address predicted = factory.predictTokenAddress(creator, p);

        vm.expectEmit(true, true, false, false, address(factory));
        emit TokenCreated(
            predicted, creator, bytes32(0), address(hook), 1, p.baseFeeBps, p.metadataURI
        );
        (address token, uint256 id) = _deploy(creator, p);

        assertEq(token, predicted);
        assertEq(factory.tokenCount(), 1);
        _assertLaunchInvariants(token, id, p);
    }

    function test_deployToken_currency1() public {
        IVeradaFactory.DeployParams memory p = _paramsOrdered(false, creator);
        (address token, uint256 id) = _deploy(creator, p);
        assertTrue(token > address(weth));
        _assertLaunchInvariants(token, id, p);
    }

    function test_deployToken_eventFields() public {
        IVeradaFactory.DeployParams memory p = _paramsOrdered(true, creator);
        vm.recordLogs();
        (address token, uint256 id) = _deploy(creator, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == TokenCreated.selector) {
                found = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), creator);
                (bytes32 pool, address h, uint256 lp, uint24 fee, string memory uri) =
                    abi.decode(logs[i].data, (bytes32, address, uint256, uint24, string));
                assertEq(pool, PoolId.unwrap(_key(token).toId()));
                assertEq(h, address(hook));
                assertEq(lp, id);
                assertEq(fee, p.baseFeeBps);
                assertEq(uri, p.metadataURI);
            }
        }
        assertTrue(found, "TokenCreated not emitted");
    }

    function test_sameSaltDifferentCreators() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(uint256(7)));
        address other = makeAddr("other");
        address a = factory.predictTokenAddress(creator, p);
        address b = factory.predictTokenAddress(other, p);
        assertTrue(a != b);
        (address ta,) = _deploy(creator, p);
        p.label = "frog-other"; // the label does not enter the address, but must be unique
        (address tb,) = _deploy(other, p);
        assertEq(ta, a);
        assertEq(tb, b);
        assertEq(factory.tokenCount(), 2);
    }

    function test_duplicateReverts() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(uint256(1)));
        (address token,) = _deploy(creator, p);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.TokenAlreadyDeployed.selector, token));
        factory.deployToken(p);
    }

    function test_preInitializedPoolReverts() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(uint256(2)));
        address token = factory.predictTokenAddress(creator, p);
        // A griefer initializing the predicted pool first makes the launch revert atomically.
        PoolKey memory key = _key(token);
        vm.expectRevert();
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0)); // hook rejects: not configured
        assertEq(factory.tokenCount(), 0);
    }

    function test_rejectsValue() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(VeradaFactory.UnexpectedValue.selector);
        factory.deployToken{value: 1}(p);
    }

    function test_feeBoundsRevert() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.baseFeeBps = 99;
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.InvalidFee.selector, uint24(99)));
        factory.deployToken(p);
        p.baseFeeBps = 501;
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.InvalidFee.selector, uint24(501)));
        factory.deployToken(p);

        p.baseFeeBps = 100;
        (address t1,) = _deploy(creator, p);
        assertTrue(t1 != address(0));
        p.baseFeeBps = 500;
        p.salt = bytes32(uint256(1));
        p.label = _label(p.salt);
        (address t2,) = _deploy(creator, p);
        assertTrue(t2 != address(0));
    }

    function test_sniperBoundsRevert() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.sniperFeeStartBps = 8001;
        p.sniperDecaySeconds = 60;
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.InvalidSniperFee.selector, uint24(8001))
        );
        factory.deployToken(p);

        p.sniperFeeStartBps = 5000;
        p.sniperDecaySeconds = 0;
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.InvalidSniperFee.selector, uint24(5000))
        );
        factory.deployToken(p);

        p.sniperDecaySeconds = 1 days + 1;
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.InvalidSniperFee.selector, uint24(5000))
        );
        factory.deployToken(p);

        p.sniperFeeStartBps = 8000;
        p.sniperDecaySeconds = 1 days;
        (address t,) = _deploy(creator, p);
        assertEq(IVeradaHook(address(hook)).feeConfig(t).sniperFeeStartBps, 8000);
    }

    function test_startTickValidation() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.startTick = -230_201; // not aligned to spacing
        vm.expectRevert(
            abi.encodeWithSelector(VeradaFactory.InvalidStartTick.selector, int24(-230_201))
        );
        factory.deployToken(p);

        int24 limit = TickMath.maxUsableTick(200);
        p.startTick = limit;
        vm.expectRevert(abi.encodeWithSelector(VeradaFactory.InvalidStartTick.selector, limit));
        factory.deployToken(p);
        p.startTick = -limit;
        vm.expectRevert(abi.encodeWithSelector(VeradaFactory.InvalidStartTick.selector, -limit));
        factory.deployToken(p);
    }

    function test_liquidityTooLargeReverts() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.startTick = 400_000; // price far above any sane launch
        vm.expectPartialRevert(VeradaFactory.LiquidityTooLarge.selector);
        factory.deployToken(p);
    }

    function test_highButValidStartTick() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.startTick = 240_000;
        (address token, uint256 id) = _deploy(creator, p);
        _assertLaunchInvariants(token, id, p);
    }

    function test_lowStartTick() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.startTick = -887_000;
        (address token, uint256 id) = _deploy(creator, p);
        _assertLaunchInvariants(token, id, p);
    }

    function test_constructorZeroAddressReverts() public {
        vm.expectRevert(VeradaFactory.ZeroAddress.selector);
        new VeradaFactory(
            IPoolManager(address(poolManager)),
            posm,
            IQuoteRegistry(address(0)),
            IVeradaHook(address(hook)),
            ILpLocker(address(locker)),
            IFeeVault(address(vault)),
            IEpochGovernor(address(governor)),
            ITokenProfileRegistry(address(profiles))
        );
    }

    function test_constructorZeroProfileRegistryReverts() public {
        vm.expectRevert(VeradaFactory.ZeroAddress.selector);
        new VeradaFactory(
            IPoolManager(address(poolManager)),
            posm,
            IQuoteRegistry(address(registry)),
            IVeradaHook(address(hook)),
            ILpLocker(address(locker)),
            IFeeVault(address(vault)),
            IEpochGovernor(address(governor)),
            ITokenProfileRegistry(address(0))
        );
    }

    function test_collaboratorsAreFactoryGated() public {
        vm.expectRevert(MockLocker.NotFactory.selector);
        locker.lock(address(1), 1);
        vm.expectRevert(MockHook.NotFactory.selector);
        hook.configureToken(address(1), MockHook.FeeConfig(100, 0, 0, 0));
        vm.expectRevert(ITokenProfileRegistry.NotFactory.selector);
        profiles.register(address(1), "frog", creator, bytes32(0));
    }

    // ------------------------------------------------------------------ profile

    function test_profileRegistryAccessor() public view {
        assertEq(factory.profileRegistry(), address(profiles));
        assertEq(profiles.parentNode(), PARENT_NODE);
    }

    function test_registersProfile() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.label = "frog";
        p.logoRef = keccak256("logo");
        address predicted = factory.predictTokenAddress(creator, p);
        bytes32 node = keccak256(abi.encodePacked(PARENT_NODE, keccak256("frog")));

        vm.expectEmit(true, true, true, true, address(profiles));
        emit ITokenProfileRegistry.TokenRegistered(
            predicted, keccak256("frog"), "frog", creator, p.logoRef
        );
        vm.expectEmit(true, true, true, true, address(profiles));
        emit ITokenProfileRegistry.LogoChanged(predicted, p.logoRef);
        (address token, uint256 id) = _deploy(creator, p);
        assertEq(token, predicted);

        assertEq(profiles.controllerOf(token), creator, "controller is the creator");
        assertEq(profiles.editorOf(token), address(0));
        assertEq(profiles.labelOf(token), "frog");
        assertEq(profiles.labelhashOf(token), keccak256("frog"));
        assertEq(profiles.logoRefOf(token), p.logoRef);
        assertEq(profiles.nodeOf(token), node);
        assertEq(profiles.tokenByNode(node), token);
        assertEq(profiles.tokenByLabelhash(keccak256("frog")), token);
        assertEq(profiles.registeredAtOf(token), uint48(block.timestamp));
        _assertLaunchInvariants(token, id, p);

        // The creator controls the profile from the start.
        vm.prank(creator);
        profiles.setText(token, "url", "https://frog.example");
        assertEq(profiles.text(token, "url"), "https://frog.example");
    }

    function test_invalidLabelRevertsBeforePoolInit() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.label = "Frog";
        address predicted = factory.predictTokenAddress(creator, p);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, "Frog"));
        factory.deployToken(p);

        assertEq(factory.tokenCount(), 0);
        assertFalse(factory.isVeradaToken(predicted));
        assertEq(predicted.code.length, 0, "token not deployed");
        assertFalse(hook.configured(predicted), "hook untouched");
        (uint160 sqrtPriceX96,,,) =
            IPoolManager(address(poolManager)).getSlot0(_key(predicted).toId());
        assertEq(sqrtPriceX96, 0, "pool not initialized");
        assertFalse(profiles.isRegistered(predicted));
        assertFalse(locker.locked(predicted));
        assertFalse(vault.registered(predicted));

        // Too short, hyphen edges and the punycode slot are rejected the same way.
        string[4] memory bad = ["ab", "-frog", "frog-", "fr--og"];
        for (uint256 i; i < bad.length; ++i) {
            p.label = bad[i];
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, bad[i]));
            factory.deployToken(p);
        }
        assertEq(factory.tokenCount(), 0);

        // The same params with a valid label launch fine.
        p.label = "frog";
        (address token,) = _deploy(creator, p);
        assertEq(token, predicted, "label does not change the address");
        assertEq(factory.tokenCount(), 1);
    }

    function test_duplicateLabelReverts() public {
        IVeradaFactory.DeployParams memory p1 = _params(bytes32(0));
        p1.label = "frog";
        (address t1,) = _deploy(creator, p1);

        IVeradaFactory.DeployParams memory p2 = _params(bytes32(uint256(1)));
        p2.label = "frog";
        address other = makeAddr("other");
        address predicted = factory.predictTokenAddress(other, p2);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.LabelTaken.selector, keccak256("frog"), t1)
        );
        factory.deployToken(p2);
        assertEq(factory.tokenCount(), 1);
        assertFalse(factory.isVeradaToken(predicted));
        assertEq(predicted.code.length, 0);

        // Same creator, different salt, same label: also taken.
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.LabelTaken.selector, keccak256("frog"), t1)
        );
        factory.deployToken(p2);

        p2.label = "frog2";
        (address t2,) = _deploy(other, p2);
        assertTrue(t2 != t1);
        assertEq(factory.tokenCount(), 2);
    }

    function test_reservedLabel() public {
        profiles.setReservation(keccak256("verada"), true, creator);
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.label = "verada";
        address other = makeAddr("other");
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelReserved.selector, keccak256("verada")
            )
        );
        factory.deployToken(p);
        assertEq(factory.tokenCount(), 0);

        (address token,) = _deploy(creator, p);
        assertEq(profiles.labelOf(token), "verada");
        assertEq(profiles.controllerOf(token), creator);
    }

    // ------------------------------------------------------------------ trading

    function _buy(address token, uint256 wethIn) internal returns (uint256 tokensOut) {
        PoolKey memory key = _key(token);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(weth);
        weth.mint(address(this), wethIn);
        weth.approve(address(swapRouter), wethIn);
        uint256 before_ = VeradaToken(token).balanceOf(address(this));
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        tokensOut = VeradaToken(token).balanceOf(address(this)) - before_;
    }

    function test_launchedPoolIsTradable_currency0() public {
        (address token,) = _deploy(creator, _paramsOrdered(true, creator));
        assertGt(_buy(token, 1 ether), 0);
    }

    function test_launchedPoolIsTradable_currency1() public {
        (address token,) = _deploy(creator, _paramsOrdered(false, creator));
        assertGt(_buy(token, 1 ether), 0);
    }

    function test_tradableWithSniperSurcharge() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(uint256(3)));
        p.sniperFeeStartBps = 5000;
        p.sniperDecaySeconds = 600;
        (address token,) = _deploy(creator, p);
        uint256 out = _buy(token, 1 ether);
        assertGt(out, 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_deploy(bytes32 salt, address who, uint24 feeBps, int24 tickRaw, uint24 sniper)
        public
    {
        vm.assume(who != address(0) && who.code.length == 0);
        feeBps = uint24(bound(feeBps, 100, 500));
        sniper = uint24(bound(sniper, 0, 8000));
        int24 limit = TickMath.maxUsableTick(200);
        // Keep the start price in a range where liquidity fits in uint128 for either ordering.
        int24 steps =
            int24(bound(int256(tickRaw), -int256(limit / 200) + 1, int256(limit / 200) - 1));
        // Very high start prices overflow per-tick liquidity limits; confine to a sane band.
        int24 startTick = int24(bound(int256(steps), -3000, 1200)) * 200;

        IVeradaFactory.DeployParams memory p = IVeradaFactory.DeployParams({
            name: "Fuzz",
            symbol: "FZ",
            metadataURI: "ipfs://fuzz",
            salt: salt,
            baseFeeBps: feeBps,
            sniperFeeStartBps: sniper,
            sniperDecaySeconds: sniper == 0 ? 0 : 3600,
            startTick: startTick,
            quoteAsset: address(weth),
            label: "fuzz",
            logoRef: salt,
            categoryMask: FOCUS_CATEGORIES,
            regionMask: FOCUS_REGIONS
        });
        address predicted = factory.predictTokenAddress(who, p);
        (address token, uint256 id) = _deploy(who, p);
        assertEq(token, predicted);
        creator = who;
        _assertLaunchInvariants(token, id, p);
    }

    function testFuzz_invalidFeeAlwaysReverts(uint24 feeBps) public {
        vm.assume(feeBps < 100 || feeBps > 500);
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.baseFeeBps = feeBps;
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.InvalidFee.selector, feeBps));
        factory.deployToken(p);
    }

    function testFuzz_predictMatchesDeploy(bytes32 salt, address who) public {
        vm.assume(who != address(0) && who.code.length == 0);
        IVeradaFactory.DeployParams memory p = _params(salt);
        address predicted = factory.predictTokenAddress(who, p);
        (address token,) = _deploy(who, p);
        assertEq(token, predicted);
    }

    // ------------------------------------------------------------------ quote assets

    function _quote(uint256 i) internal view returns (MockQuote q, uint8 dec) {
        i = i % 3;
        if (i == 0) return (usdcLike, 6);
        if (i == 1) return (ondo8, 8);
        return (ondo18, 18);
    }

    function _paramsQuote(address quote, bool tokenIsCurrency0, int24 startTick, uint256 saltBase)
        internal
        view
        returns (IVeradaFactory.DeployParams memory p)
    {
        for (uint256 i; i < 64; ++i) {
            p = _params(bytes32(saltBase + i));
            p.quoteAsset = quote;
            p.startTick = startTick;
            if ((factory.predictTokenAddress(creator, p) < quote) == tokenIsCurrency0) return p;
        }
        revert("no salt");
    }

    function _buyQuote(address token, address quote, uint256 amountIn)
        internal
        returns (uint256 tokensOut)
    {
        PoolKey memory key = _keyFor(token, quote);
        bool zeroForOne = Currency.unwrap(key.currency0) == quote;
        MockQuote(quote).mint(address(this), amountIn);
        MockQuote(quote).approve(address(swapRouter), amountIn);
        uint256 before_ = VeradaToken(token).balanceOf(address(this));
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        tokensOut = VeradaToken(token).balanceOf(address(this)) - before_;
    }

    function _assertQuoteLaunch(
        address token,
        uint256 id,
        address quote,
        uint8 dec,
        int24 humanTick,
        uint256 poolQuoteBefore
    ) internal view {
        VeradaToken t = VeradaToken(token);
        assertEq(factory.quoteAssetOf(token), quote);
        assertEq(t.balanceOf(address(factory)), 0, "factory token balance");
        assertEq(t.balanceOf(address(poolManager)), t.totalSupply(), "pool holds supply");
        assertEq(
            MockQuote(quote).balanceOf(address(poolManager)), poolQuoteBefore, "no quote added"
        );
        assertEq(IERC721(address(posm)).ownerOf(id), address(locker));
        assertTrue(vault.registered(token));
        assertTrue(governor.registered(token));

        PoolKey memory key = _keyFor(token, quote);
        (uint160 sqrtPriceX96, int24 tick,,) =
            IPoolManager(address(poolManager)).getSlot0(key.toId());
        bool isC0 = Currency.unwrap(key.currency0) == token;
        int24 rawTick = factory.poolTickFor(humanTick, dec, true);
        assertEq(tick, isC0 ? rawTick : -rawTick, "pool tick");
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(tick));
        // Raw tick stays within half a spacing of the exact decimals-shifted tick.
        int256 exact = int256(humanTick) + (int256(uint256(dec)) - 18) * 23_027;
        int256 diff = int256(rawTick) - exact;
        assertLe(diff < 0 ? -diff : diff, 100, "rounding bound");
        assertEq(int256(rawTick) % 200, 0, "aligned");
    }

    function test_quoteRegistryAccessors() public view {
        assertEq(factory.quoteRegistry(), address(registry));
    }

    function test_unregisteredQuoteReverts() public {
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.quoteAsset = address(0xdead);
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.QuoteAssetNotAllowed.selector, address(0xdead))
        );
        factory.deployToken(p);

        p.quoteAsset = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.QuoteAssetNotAllowed.selector, address(0))
        );
        factory.deployToken(p);
    }

    function test_deactivatedQuoteReverts() public {
        registry.set(address(ondo8), 8, true, false);
        IVeradaFactory.DeployParams memory p = _params(bytes32(0));
        p.quoteAsset = address(ondo8);
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.QuoteAssetNotAllowed.selector, address(ondo8))
        );
        factory.deployToken(p);
        assertEq(factory.tokenCount(), 0);
    }

    function test_poolTickShiftsByDecimals() public view {
        assertEq(factory.poolTickFor(-230_200, 18, true), -230_200);
        assertEq(factory.poolTickFor(-230_200, 18, false), 230_200);
        // 6 decimals: shift by -12 decades = -276_324, snapped to -276_400 (human -230_200).
        assertEq(factory.poolTickFor(0, 6, true), -276_400);
        assertEq(factory.poolTickFor(0, 6, false), 276_400);
        // 8 decimals: -230_270 -> -230_200.
        assertEq(factory.poolTickFor(0, 8, true), -230_200);
        // Rounds halves up and handles negatives.
        assertEq(factory.poolTickFor(-200, 8, true), -230_400);
    }

    function test_poolTickOutOfRangeReverts() public {
        // 6-decimal quote pushes a very low human tick below the usable range.
        vm.expectRevert(
            abi.encodeWithSelector(VeradaFactory.InvalidStartTick.selector, int24(-700_000))
        );
        factory.poolTickFor(-700_000, 6, true);
    }

    /// @dev A launch at human tick 0 prices one whole token at one whole quote unit, for every
    ///      quote decimals and both currency orderings: buying one whole quote unit returns about
    ///      one whole token.
    function test_priceMatchesAcrossDecimals() public {
        for (uint256 q; q < 3; ++q) {
            for (uint256 o; o < 2; ++o) {
                (MockQuote quote, uint8 dec) = _quote(q);
                IVeradaFactory.DeployParams memory p =
                    _paramsQuote(address(quote), o == 0, 0, (q * 2 + o) * 1000);
                uint256 poolQuoteBefore = quote.balanceOf(address(poolManager));
                (address token, uint256 id) = _deploy(creator, p);
                assertEq(
                    quote.balanceOf(address(poolManager)), poolQuoteBefore, "launch adds no quote"
                );
                _assertQuoteLaunch(token, id, address(quote), dec, 0, poolQuoteBefore);

                uint256 out = _buyQuote(token, address(quote), 10 ** dec);
                // Snapping moves the price by at most ~1%; allow 2%.
                assertApproxEqRel(out, 1e18, 0.02e18, "one quote unit buys ~one token");
            }
        }
    }

    function test_ondoQuoteLaunchHoldsNoQuote() public {
        IVeradaFactory.DeployParams memory p = _paramsQuote(address(usdcLike), true, -230_200, 0);
        (address token, uint256 id) = _deploy(creator, p);
        _assertQuoteLaunch(token, id, address(usdcLike), 6, -230_200, 0);
        assertEq(usdcLike.balanceOf(address(factory)), 0);
    }

    function testFuzz_deployAcrossDecimals(uint256 qi, bytes32 salt, int24 stepRaw, bool buy)
        public
    {
        (MockQuote quote, uint8 dec) = _quote(qi);
        int24 humanTick = int24(bound(int256(stepRaw), -2000, 1200)) * 200;
        IVeradaFactory.DeployParams memory p = _params(salt);
        p.quoteAsset = address(quote);
        p.startTick = humanTick;
        address predicted = factory.predictTokenAddress(creator, p);
        (address token, uint256 id) = _deploy(creator, p);
        assertEq(token, predicted);
        _assertQuoteLaunch(token, id, address(quote), dec, humanTick, 0);
        if (buy) assertGt(_buyQuote(token, address(quote), 10 ** dec), 0);
    }
}
