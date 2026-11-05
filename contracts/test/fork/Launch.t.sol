// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {DonationDistributor} from "../../src/DonationDistributor.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {VeradaFactory} from "../../src/VeradaFactory.sol";
import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {PublicSnapshotVerifier} from "../../src/governance/PublicSnapshotVerifier.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaFactory} from "../../src/interfaces/IVeradaFactory.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Mainnet-fork test: deploy the system with the real script, launch a token, swap,
///         split fees, vote, finalize, settle and distribute. Skipped when ETH_RPC_URL is unset.
contract LaunchForkTest is Test, Deploy {
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant ORG_ID = bytes32("999000111");
    bytes32 internal constant CAUSE_ID = keccak256("test-nonprofit-ein");

    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    // Wikimedia Foundation (EIN 200049703): an Endaoment org already deployed on mainnet.
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant WIKI_CAUSE = keccak256("wikimedia-foundation");

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal voter = makeAddr("voter");
    address internal payout = makeAddr("payout");

    Deployment internal d;
    PoolSwapTest internal swapRouter;
    VeradaToken internal token;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // The unauthenticated stub verifier is deployed here, in the test only.
        address verifier = address(new PublicSnapshotVerifier());

        vm.startBroadcast(deployer);
        d = deploy(Config({owner: owner, platformTreasury: treasury, verifier: verifier}), deployer);
        vm.stopBroadcast();

        vm.startPrank(owner);
        CauseRegistry(d.causeRegistry).acceptOwnership();
        EpochGovernor(d.epochGovernor).acceptOwnership();
        DonationDistributor(d.donationDistributor).acceptOwnership();
        FeeVault(d.feeVault).acceptOwnership();
        QuoteRegistry(d.quoteRegistry).acceptOwnership();
        FeeConsolidator(payable(d.feeConsolidator)).acceptOwnership();
        CauseRegistry(d.causeRegistry)
            .addCause(
                CAUSE_ID,
                ORG_ID,
                IEndaomentOrgFundFactory(ENDAOMENT_FACTORY).computeOrgAddress(ORG_ID),
                "ipfs://cause"
            );

        CauseRegistry(d.causeRegistry).addCause(WIKI_CAUSE, WIKI_ORG, WIKI_ADDR, "ipfs://wiki");

        // WETH is a quote asset through the real native ETH/USDC pool.
        PoolKey memory ethKey =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        assertEq(
            PoolId.unwrap(ethKey.toId()),
            0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27,
            "ETH/USDC pool id"
        );
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethKey;
        QuoteRegistry(d.quoteRegistry)
            .addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(route);

        // AMZNon (an Ondo token) is a quote asset through its real 1% pool against USDC.
        PoolKey memory amznKey =
            PoolKey(Currency.wrap(USDC), Currency.wrap(AMZN_ON), 10_000, 100, IHooks(address(0)));
        assertEq(
            PoolId.unwrap(amznKey.toId()),
            0x267d70816c37d531818dfe2224a1e5beac46fe74929f2370433c1918facb3a8d,
            "AMZNon/USDC pool id"
        );
        PoolKey[] memory amznRoute = new PoolKey[](1);
        amznRoute[0] = amznKey;
        QuoteRegistry(d.quoteRegistry)
            .addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, amznRoute);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(amznRoute);
        vm.stopPrank();

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
    }

    function test_deploymentWiring() public view {
        assertEq(uint160(d.hook) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS, "hook flags");
        assertEq(FeeVault(d.feeVault).owner(), owner);
        assertEq(EpochGovernor(d.epochGovernor).factory(), d.factory);
        assertEq(DonationDistributor(d.donationDistributor).feeVault(), d.feeVault);
        assertEq(FeeVault(d.feeVault).consolidator(), d.feeConsolidator);
        assertEq(FeeVault(d.feeVault).settlementAsset(), USDC);
        FeeConsolidator cons = FeeConsolidator(payable(d.feeConsolidator));
        assertEq(cons.hook(), d.hook);
        assertTrue(cons.isSource(d.hook));
        assertTrue(cons.isSource(d.lpLocker));
        assertEq(cons.settlementAsset(), USDC);
        assertEq(FeeVault(d.feeVault).PLATFORM_SHARE_BPS(), 1000);
        assertEq(address(VeradaFactory(d.factory).hook()), d.hook);
        assertEq(address(VeradaFactory(d.factory).locker()), d.lpLocker);
    }

    function test_launchSwapSplitVoteDistribute() public {
        // WETH quote, voted cause is a synthetic org that the distributor deploys and funds.
        _endToEnd(WETH, 5 ether, bytes32(uint256(1)), CAUSE_ID, ORG_ID, address(0));
    }

    /// @notice Ondo-paired launch: a real Ondo token is the quote currency, fees are swapped
    ///         through the real AMZNon/USDC pool and the cause funds reach a deployed Endaoment org.
    function test_ondoQuote_launchSwapConsolidateVoteDistribute() public {
        _endToEnd(AMZN_ON, 0.05 ether, bytes32(uint256(2)), WIKI_CAUSE, WIKI_ORG, WIKI_ADDR);
    }

    /// @dev launch -> swap -> collect -> vote -> finalize -> settle -> distribute to Endaoment.
    ///      `expectedOrg` is the already-deployed org to check balances on (zero: use the
    ///      computed address of `orgId`, which is deployed by the distributor).
    function _endToEnd(
        address quote,
        uint256 spend,
        bytes32 salt,
        bytes32 causeId,
        bytes32 orgId,
        address expectedOrg
    ) internal {
        // ---- launch
        IVeradaFactory.DeployParams memory p = IVeradaFactory.DeployParams({
            name: "Fork Coin",
            symbol: "FORK",
            metadataURI: "ipfs://meta",
            salt: salt,
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: quote
        });
        vm.prank(creator);
        (address tokenAddr, uint256 lpTokenId) = VeradaFactory(d.factory).deployToken(p);
        token = VeradaToken(tokenAddr);
        assertEq(VeradaLpLocker(d.lpLocker).lpTokenIdOf(tokenAddr), lpTokenId);
        assertEq(token.creator(), creator);
        assertEq(token.balanceOf(d.factory), 0, "factory holds no tokens");

        // ---- swap: buy the token with the quote asset
        _fund(quote, trader, spend);
        vm.startPrank(trader);
        IERC20(quote).approve(address(swapRouter), type(uint256).max);
        PoolKey memory key = _key(tokenAddr, quote);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quote;
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: quoteIsCurrency0,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: quoteIsCurrency0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertGt(token.balanceOf(trader), 0, "trader received tokens");

        // ---- fees: raw quote fees are swapped to USDC, then split 10% / 90%
        FeeVault vault = FeeVault(d.feeVault);
        (uint256 a0, uint256 a1) = VeradaLpLocker(d.lpLocker).collectFees(tokenAddr);
        uint256 collected = quoteIsCurrency0 ? a0 : a1;
        assertApproxEqAbs(collected, (spend * 300) / 10_000, spend / 1e6, "3% of the input");
        assertEq(
            FeeConsolidator(payable(d.feeConsolidator)).heldFees(tokenAddr, quote),
            0,
            "nothing held"
        );
        assertEq(IERC20(quote).balanceOf(d.feeConsolidator), 0, "consolidator keeps no quote");

        uint256 total = vault.totalTracked();
        assertGt(total, 0, "fees consolidated into USDC");
        uint256 platformFee = vault.platformAccrued();
        uint256 causeFee = vault.causePool(tokenAddr);
        assertEq(platformFee + causeFee, total, "split sums to tracked");
        assertEq(platformFee, (total * 1000) / 10_000, "platform share is 10%");
        assertEq(IERC20(USDC).balanceOf(d.feeVault), total, "vault holds USDC only");

        // ---- vote in the current epoch
        EpochGovernor governor = EpochGovernor(d.epochGovernor);
        uint256 epoch = governor.currentEpoch();
        governor.castVote(tokenAddr, causeId, abi.encode(voter, uint256(1000 ether)));

        // ---- finalize after the epoch ends, settle into the distributor
        vm.warp(governor.epochZeroStart() + (epoch + 1) * governor.EPOCH_LENGTH());
        governor.finalizeEpoch(tokenAddr, epoch);
        assertEq(governor.winningCause(tokenAddr, epoch), causeId);

        vault.settle(tokenAddr, epoch);
        assertEq(vault.causePool(tokenAddr), 0);
        assertEq(IERC20(USDC).balanceOf(d.donationDistributor), causeFee, "cause pool moved");

        // ---- distribute into the real Endaoment org (net of the org's own fee)
        address org = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY).computeOrgAddress(orgId);
        if (expectedOrg != address(0)) {
            assertEq(org, expectedOrg, "org address");
            assertGt(org.code.length, 0, "org is deployed");
        } else {
            assertEq(org.code.length, 0, "org not deployed yet");
        }
        uint256 orgBefore = IERC20(USDC).balanceOf(org);
        DonationDistributor(d.donationDistributor).distribute(tokenAddr, epoch);
        assertGt(org.code.length, 0, "org exists after distribute");
        assertGt(IERC20(USDC).balanceOf(org), orgBefore, "org received USDC");
        assertEq(IERC20(USDC).balanceOf(d.donationDistributor), 0, "distributor drained");
        assertLe(IERC20(USDC).balanceOf(org) - orgBefore, causeFee);

        // ---- platform withdraws its share to the treasury
        vault.withdrawPlatform();
        assertEq(IERC20(USDC).balanceOf(treasury), platformFee);
    }

    /// @dev WETH is wrapped from ETH; Ondo tokens are taken from the real pool manager.
    function _fund(address quote, address to, uint256 amount) internal {
        if (quote == WETH) {
            deal(to, amount);
            vm.prank(to);
            IWETH(WETH).deposit{value: amount}();
        } else {
            vm.prank(POOL_MANAGER);
            IERC20(quote).transfer(to, amount);
        }
    }

    function _key(address tokenAddr, address quote) internal view returns (PoolKey memory) {
        (address c0, address c1) = tokenAddr < quote ? (tokenAddr, quote) : (quote, tokenAddr);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0x800000,
            tickSpacing: 200,
            hooks: IHooks(d.hook)
        });
    }
}
