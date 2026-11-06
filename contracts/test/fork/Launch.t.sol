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
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {DonationDistributor} from "../../src/DonationDistributor.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {TakeoverGovernor} from "../../src/TakeoverGovernor.sol";
import {TokenProfileRegistry} from "../../src/TokenProfileRegistry.sol";
import {VeradaFactory} from "../../src/VeradaFactory.sol";
import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {VeradaResolver} from "../../src/VeradaResolver.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVeradaFactory} from "../../src/interfaces/IVeradaFactory.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Mainnet-fork test: deploy the system with the real script, launch a token, swap,
///         split fees, vote, finalize, settle and distribute. Skipped when ETH_RPC_URL is unset.
contract LaunchForkTest is Test, Deploy {
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant ORG_ID = bytes32("999000111");
    bytes32 internal constant CAUSE_ID = keccak256(abi.encode(ORG_ID));

    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    // Wikimedia Foundation (EIN 200049703): an Endaoment org already deployed on mainnet.
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant WIKI_CAUSE = keccak256(abi.encode(WIKI_ORG));

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal voter = makeAddr("voter");
    address internal payout = makeAddr("payout");

    /// @dev A made-up Swarm reference standing in for the site feed manifest.
    bytes32 internal constant SITE_REF =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    Deployment internal d;
    PoolSwapTest internal swapRouter;
    VeradaToken internal token;
    /// @dev Plaintext scheme used for the vote: the Zama scheme needs the relayer to produce
    ///      ballots, which a fork cannot do. The governor is scheme-agnostic.
    MockVotingScheme internal mockScheme;
    /// @dev Catalogue published in setUp: [ORG_ID, WIKI_ORG] in the hunger x Africa bucket.
    bytes32[] internal catalogOrgs;
    bytes32[] internal catalogLeaves;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vm.startBroadcast(deployer);
        d = deploy(
            Config({owner: owner, platformTreasury: treasury, siteSwarmRef: SITE_REF}), deployer
        );
        vm.stopBroadcast();

        mockScheme = new MockVotingScheme();
        mockScheme.setGovernor(d.epochGovernor, true);

        vm.startPrank(owner);
        CauseRegistry(d.causeRegistry).acceptOwnership();
        EpochGovernor(d.epochGovernor).acceptOwnership();
        DonationDistributor(d.donationDistributor).acceptOwnership();
        FeeVault(d.feeVault).acceptOwnership();
        QuoteRegistry(d.quoteRegistry).acceptOwnership();
        FeeConsolidator(payable(d.feeConsolidator)).acceptOwnership();
        TokenProfileRegistry(d.profileRegistry).acceptOwnership();
        ZamaVotingScheme(d.votingScheme).acceptOwnership();
        TakeoverGovernor(d.takeoverGovernor).acceptOwnership();
        CauseCatalog(d.causeCatalog).acceptOwnership();
        // Ballot options for every token: the two catalogue orgs, in this order. Neither is in the
        // registry until it wins; the governor materializes the winner from the live factory.
        catalogOrgs.push(ORG_ID);
        catalogOrgs.push(WIKI_ORG);
        catalogLeaves = CatalogPublish.publish(CauseCatalog(d.causeCatalog), catalogOrgs);
        EpochGovernor(d.epochGovernor).setScheme(IVotingScheme(address(mockScheme)));

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
        assertEq(address(FeeVault(d.feeVault).lpLocker()), d.lpLocker);
        assertEq(cons.settlementAsset(), USDC);
        assertEq(FeeVault(d.feeVault).PLATFORM_SHARE_BPS(), 1000);
        assertEq(address(VeradaFactory(d.factory).hook()), d.hook);
        assertEq(address(VeradaFactory(d.factory).locker()), d.lpLocker);
        assertEq(VeradaFactory(d.factory).profileRegistry(), d.profileRegistry);

        TokenProfileRegistry profiles = TokenProfileRegistry(d.profileRegistry);
        assertEq(profiles.factory(), d.factory);
        assertEq(profiles.governor(), d.takeoverGovernor);
        assertEq(profiles.platformAddress(), treasury);
        assertEq(profiles.owner(), owner);
        assertEq(profiles.defaultContenthash(), abi.encodePacked(hex"e40101fa011b20", SITE_REF));
        assertEq(VeradaResolver(d.resolver).parentNode(), profiles.parentNode());
        assertEq(address(VeradaResolver(d.resolver).registry()), d.profileRegistry);
        ZamaVotingScheme zama = ZamaVotingScheme(d.votingScheme);
        assertTrue(zama.isGovernor(d.epochGovernor));
        assertTrue(zama.isGovernor(d.takeoverGovernor));
        assertEq(zama.owner(), owner);
        assertEq(TakeoverGovernor(d.takeoverGovernor).registry(), d.profileRegistry);
        assertEq(TakeoverGovernor(d.takeoverGovernor).scheme(), d.votingScheme);
        assertEq(TakeoverGovernor(d.takeoverGovernor).owner(), owner);
        assertEq(TakeoverGovernor(d.takeoverGovernor).poolManager(), POOL_MANAGER);
        assertEq(TakeoverGovernor(d.takeoverGovernor).params().lookback, 7 days);
    }

    function test_launchSwapSplitVoteDistribute() public {
        // WETH quote, voted cause is a synthetic org that the distributor deploys and funds.
        _endToEnd(WETH, 5 ether, bytes32(uint256(1)), "fork-coin", 0, CAUSE_ID, ORG_ID, address(0));
    }

    /// @notice Ondo-paired launch: a real Ondo token is the quote currency, fees are swapped
    ///         through the real AMZNon/USDC pool and the cause funds reach a deployed Endaoment org.
    function test_ondoQuote_launchSwapConsolidateVoteDistribute() public {
        _endToEnd(
            AMZN_ON,
            0.05 ether,
            bytes32(uint256(2)),
            "fork-ondo",
            1,
            WIKI_CAUSE,
            WIKI_ORG,
            WIKI_ADDR
        );
    }

    /// @dev launch -> swap -> collect -> vote -> finalize -> settle -> distribute to Endaoment.
    ///      `expectedOrg` is the already-deployed org to check balances on (zero: use the
    ///      computed address of `orgId`, which is deployed by the distributor). `option` is the
    ///      index of `causeId` on the ballot.
    function _endToEnd(
        address quote,
        uint256 spend,
        bytes32 salt,
        string memory label,
        uint8 option,
        bytes32 causeId,
        bytes32 orgId,
        address expectedOrg
    ) internal {
        // ---- launch
        IVeradaFactory.DeployParams memory p = IVeradaFactory.DeployParams({
            name: "Fork Coin",
            symbol: "FORK",
            metadataURI: "bzz://1111111111111111111111111111111111111111111111111111111111111111",
            salt: salt,
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: quote,
            label: label,
            logoRef: bytes32(uint256(0xabc)),
            categoryMask: CatalogPublish.CATEGORIES,
            regionMask: CatalogPublish.REGIONS
        });
        vm.prank(creator);
        (address tokenAddr, uint256 lpTokenId) = VeradaFactory(d.factory).deployToken(p);
        token = VeradaToken(tokenAddr);
        assertEq(VeradaLpLocker(d.lpLocker).lpTokenIdOf(tokenAddr), lpTokenId);
        assertEq(token.creator(), creator);
        assertEq(token.balanceOf(d.factory), 0, "factory holds no tokens");

        // ---- profile: the label is registered and the creator controls it
        TokenProfileRegistry profiles = TokenProfileRegistry(d.profileRegistry);
        assertEq(profiles.tokenByLabelhash(keccak256(bytes(label))), tokenAddr);
        assertEq(profiles.controllerOf(tokenAddr), creator);
        assertEq(profiles.labelOf(tokenAddr), label);
        assertEq(profiles.logoRefOf(tokenAddr), bytes32(uint256(0xabc)));

        // ---- epoch e0: a first trade seeds the voter with tokens. Weights come from the
        //      snapshot the second before the vote epoch starts, so the voter must hold before it.
        EpochGovernor governor = EpochGovernor(d.epochGovernor);
        PoolKey memory key = _key(tokenAddr, quote);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quote;
        _buy(key, quote, quoteIsCurrency0, spend);
        assertGt(token.balanceOf(trader), 0, "trader received tokens");
        uint256 half = token.balanceOf(trader) / 2;
        vm.prank(trader);
        token.transfer(voter, half);

        // ---- epoch e1 starts. LP fees are attributed to epochs in proportion to the time since
        //      the previous collection, so collecting exactly at the boundary credits everything
        //      earned so far to e0 and keeps it out of the vote epoch's pool.
        uint256 epoch = governor.currentEpoch() + 1;
        vm.warp(governor.epochStart(epoch));
        VeradaLpLocker(d.lpLocker).collectFees(tokenAddr);
        FeeVault vault = FeeVault(d.feeVault);
        uint256 earlierPool = vault.causePool(tokenAddr);
        uint256 earlierPlatform = vault.platformAccrued();
        uint256 earlierTracked = vault.totalTracked();

        // ---- epoch e1: trade again so fees accrue to the epoch being voted on
        assertGt(governor.weightOf(tokenAddr, epoch, voter), 0, "voter has weight");
        _buy(key, quote, quoteIsCurrency0, spend);

        // ---- fees: collected a day later, so the whole accrual interval lies inside e1; raw
        //      quote fees are swapped to USDC, then split 10% / 90%
        vm.warp(block.timestamp + 1 days);
        (uint256 a0, uint256 a1) = VeradaLpLocker(d.lpLocker).collectFees(tokenAddr);
        uint256 collected = quoteIsCurrency0 ? a0 : a1;
        assertApproxEqAbs(collected, (spend * 300) / 10_000, spend / 1e6, "3% of the input");
        assertEq(
            FeeConsolidator(payable(d.feeConsolidator)).heldFees(tokenAddr, quote),
            0,
            "nothing held"
        );
        assertEq(IERC20(quote).balanceOf(d.feeConsolidator), 0, "consolidator keeps no quote");

        uint256 total = vault.totalTracked() - earlierTracked;
        assertGt(total, 0, "fees consolidated into USDC");
        uint256 platformFee = vault.platformAccrued() - earlierPlatform;
        uint256 causeFee = vault.causePoolOf(tokenAddr, epoch);
        assertEq(platformFee + causeFee, total, "split sums to tracked");
        assertApproxEqAbs(platformFee, (total * 1000) / 10_000, 2, "platform share is 10%");
        assertEq(IERC20(USDC).balanceOf(d.feeVault), vault.totalTracked(), "vault holds USDC only");

        // ---- prepare e1's ballot (the whole two-org pool, in order), then vote through the scheme
        governor.prepareBallot(
            tokenAddr, epoch, CatalogPublish.allDraws(catalogOrgs, catalogLeaves)
        );
        assertEq(governor.epochOptions(tokenAddr, epoch)[option], causeId);
        vm.prank(voter);
        mockScheme.castBallot(d.epochGovernor, tokenAddr, epoch, abi.encode(option));
        assertTrue(governor.hasVoted(tokenAddr, epoch, voter));
        assertEq(governor.voterCount(tokenAddr, epoch), 1);

        // ---- finalize after the epoch ends, settle e1 into the distributor
        vm.warp(governor.epochStart(epoch + 1));
        governor.closeEpoch(tokenAddr, epoch);
        mockScheme.finalizeFromBallots(d.epochGovernor, tokenAddr, epoch);
        governor.finalizeEpoch(tokenAddr, epoch);
        assertEq(governor.winningCause(tokenAddr, epoch), causeId);
        assertEq(
            governor.tally(tokenAddr, epoch, causeId), governor.weightOf(tokenAddr, epoch, voter)
        );

        vault.settle(tokenAddr, epoch);
        assertEq(vault.causePool(tokenAddr), earlierPool, "only the voted epoch settled");
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
        assertEq(IERC20(USDC).balanceOf(treasury), earlierPlatform + platformFee);
    }

    /// @dev Funds `trader` with `spend` of the quote asset and buys the token with it.
    function _buy(PoolKey memory key, address quote, bool quoteIsCurrency0, uint256 spend)
        internal
    {
        _fund(quote, trader, spend);
        vm.startPrank(trader);
        IERC20(quote).approve(address(swapRouter), type(uint256).max);
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
