// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {DonationDistributor} from "../../src/DonationDistributor.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IDonationDistributor} from "../../src/interfaces/IDonationDistributor.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrg} from "../../src/interfaces/external/IEndaomentOrg.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {IEndaomentRegistry} from "../../src/interfaces/external/IEndaomentRegistry.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @notice Mainnet-fork test of cause registration and donation against the real Endaoment
///         OrgFundFactory and Registry. Skipped when ETH_RPC_URL is unset.
contract EndaomentDonationForkTest is Test {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant ENDAOMENT_FACTORY = 0x10fD9348136dCea154F752fe0B6dB45Fc298A589;
    address internal constant ENDAOMENT_REGISTRY = 0x94106cA9c7E567109A1D39413052887d1F412183;

    // Wikimedia Foundation (EIN 200049703): deployed on mainnet.
    bytes32 internal constant ORG_DEPLOYED = bytes32("200049703");
    address internal constant ORG_DEPLOYED_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    // Wikimedia Endowment (EIN 873024488): its API-reported address (deployed or not).
    bytes32 internal constant ORG_ENDOWMENT = bytes32("873024488");
    address internal constant ORG_ENDOWMENT_ADDR = 0x2EDFF2D6AE1c9E5345F1D4A4437bB8fB1BCf9560;
    // Synthetic EIN used to exercise deploy-and-donate regardless of what is deployed today.
    bytes32 internal constant ORG_FRESH = bytes32("999000111");

    uint256 internal constant WEEK = 7 days;

    IEndaomentOrgFundFactory internal eFactory = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY);
    IEndaomentRegistry internal eRegistry = IEndaomentRegistry(ENDAOMENT_REGISTRY);

    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    EpochGovernor internal gov;
    DonationDistributor internal dist;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal vault = makeAddr("vault");
    address internal launchFactory = makeAddr("launchFactory");
    address internal voter = makeAddr("voter");
    // Catalogue causes, materialized from the live factory's address when they win.
    bytes32 internal causeDeployed = keccak256(abi.encode(ORG_DEPLOYED));
    bytes32 internal causeFresh = keccak256(abi.encode(ORG_FRESH));

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // Launch the token and fund a holder a week before the governor exists, so the holder has
        // weight at epoch 0's snapshot.
        VeradaToken tokenContract = new VeradaToken(
            "Verada Test", "VTEST", "ipfs://meta", makeAddr("creator"), launchFactory
        );
        token = address(tokenContract);
        vm.prank(launchFactory);
        tokenContract.transfer(voter, 1000e18);
        vm.warp(block.timestamp + WEEK);

        registry = new CauseRegistry(owner, eFactory);
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(2);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        CatalogFixture cat = new CatalogFixture();
        cat.add(cat.bucketOf(2, 0), ORG_DEPLOYED);
        cat.add(cat.bucketOf(2, 0), ORG_FRESH);
        cat.publish();
        gov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            scheme,
            ITokenProfileRegistry(address(profiles))
        );
        scheme.setGovernor(address(gov), true);
        profiles.register(token, makeAddr("creator"));
        profiles.setFocus(token, uint64(1) << 2, uint16(1));
        dist = new DonationDistributor(owner, gov, registry, eFactory);

        vm.startPrank(owner);
        gov.setFactory(launchFactory);
        dist.setFeeVault(vault);
        registry.setMaterializer(address(gov), true);
        vm.stopPrank();
        vm.prank(launchFactory);
        gov.registerToken(token);
        IEpochGovernor.Pin[] memory pins = new IEpochGovernor.Pin[](2);
        pins[0] = cat.pin(0);
        pins[1] = cat.pin(1);
        vm.prank(makeAddr("creator"));
        gov.setShortlist(token, pins);
    }

    function _fund(uint256 epoch, uint256 amount) internal {
        deal(USDC, address(dist), IERC20(USDC).balanceOf(address(dist)) + amount);
        vm.prank(vault);
        dist.receiveFunds(token, epoch, amount);
    }

    function _finalize(bytes32 cause) internal {
        uint8 choice = cause == causeDeployed ? 0 : 1;
        // Ballots are rejected until the epoch is opened; both pool entries are pinned, so no
        // rotation draws are needed.
        gov.openEpoch(token, 0);
        vm.prank(voter);
        scheme.castBallot(address(gov), token, 0, abi.encode(choice));
        vm.warp(gov.epochStart(1));
        gov.closeEpoch(token, 0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
    }

    // ---- on-chain constants and address derivation

    function test_endaomentAddresses_areConsistent() public view {
        assertGt(ENDAOMENT_FACTORY.code.length, 0);
        assertGt(ENDAOMENT_REGISTRY.code.length, 0);
        assertEq(eFactory.registry(), ENDAOMENT_REGISTRY);
        assertEq(eFactory.baseToken(), USDC);
        assertEq(eRegistry.baseToken(), USDC);
        assertEq(dist.settlementAsset(), USDC);
        assertEq(address(dist.endaomentRegistry()), ENDAOMENT_REGISTRY);
    }

    function test_computeOrgAddress_matchesKnownOrgs() public view {
        assertEq(eFactory.computeOrgAddress(ORG_DEPLOYED), ORG_DEPLOYED_ADDR);
        assertEq(eFactory.computeOrgAddress(ORG_ENDOWMENT), ORG_ENDOWMENT_ADDR);
    }

    function test_deployedOrg_isActiveWithOrgId() public view {
        assertGt(ORG_DEPLOYED_ADDR.code.length, 0);
        assertTrue(eRegistry.isActiveEntity(ORG_DEPLOYED_ADDR));
        assertEq(IEndaomentOrg(ORG_DEPLOYED_ADDR).orgId(), ORG_DEPLOYED);
        assertEq(IEndaomentOrg(ORG_DEPLOYED_ADDR).baseToken(), USDC);
    }

    function test_registry_rejectsWrongOrgAddressAgainstRealFactory() public {
        address real = eFactory.computeOrgAddress(ORG_ENDOWMENT);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CauseRegistry.OrgAddressMismatch.selector, ORG_ENDOWMENT, real, ORG_DEPLOYED_ADDR
            )
        );
        registry.addCause(keccak256("bad"), ORG_ENDOWMENT, ORG_DEPLOYED_ADDR, "");

        // The hyphenated EIN form does not derive the real org, so it is not accepted either.
        bytes32 hyphenated = bytes32("20-0049703");
        address other = eFactory.computeOrgAddress(hyphenated);
        assertTrue(other != ORG_DEPLOYED_ADDR);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CauseRegistry.OrgAddressMismatch.selector, hyphenated, other, ORG_DEPLOYED_ADDR
            )
        );
        registry.addCause(keccak256("bad2"), hyphenated, ORG_DEPLOYED_ADDR, "");
    }

    // ---- donations

    function test_distribute_donatesToDeployedOrg() public {
        uint256 amount = 1000e6;
        uint32 fee = dist.endaomentFeeFor(ORG_DEPLOYED_ADDR);
        assertEq(fee, eRegistry.getDonationFee(ORG_DEPLOYED_ADDR));
        emit log_named_uint("on-chain donation fee (zoc)", fee);

        _fund(0, amount);
        _finalize(causeDeployed);

        uint256 orgBefore = IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR);
        uint256 treasuryBefore = IERC20(USDC).balanceOf(eRegistry.treasury());

        vm.expectEmit(true, true, true, true);
        emit IDonationDistributor.Donated(token, 0, causeDeployed, ORG_DEPLOYED_ADDR, amount);
        dist.distribute(token, 0);

        uint256 orgDelta = IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR) - orgBefore;
        uint256 treasuryDelta = IERC20(USDC).balanceOf(eRegistry.treasury()) - treasuryBefore;
        assertEq(orgDelta + treasuryDelta, amount, "all USDC left the distributor");
        assertApproxEqAbs(treasuryDelta, amount * fee / 10_000, 1, "fee is the on-chain fee");
        assertEq(IERC20(USDC).balanceOf(address(dist)), 0);
        assertEq(IERC20(USDC).allowance(address(dist), ORG_DEPLOYED_ADDR), 0);
        assertEq(IERC20(USDC).allowance(address(dist), ENDAOMENT_FACTORY), 0);
        assertTrue(dist.distributed(token, 0));
        assertEq(dist.reserved(), 0);
    }

    function test_distribute_deploysUndeployedOrgAndDonates() public {
        address org = eFactory.computeOrgAddress(ORG_FRESH);
        assertEq(org.code.length, 0, "fresh org must not exist yet");
        assertFalse(eRegistry.isActiveEntity(org));

        uint256 amount = 250e6;
        _fund(0, amount);
        _finalize(causeFresh);

        uint256 treasuryBefore = IERC20(USDC).balanceOf(eRegistry.treasury());
        vm.expectEmit(true, true, false, false);
        emit IDonationDistributor.OrgDeployed(ORG_FRESH, org);
        dist.distribute(token, 0);

        assertGt(org.code.length, 0, "org deployed by the factory");
        assertTrue(eRegistry.isActiveEntity(org));
        assertEq(IEndaomentOrg(org).orgId(), ORG_FRESH);
        uint256 treasuryDelta = IERC20(USDC).balanceOf(eRegistry.treasury()) - treasuryBefore;
        assertEq(IERC20(USDC).balanceOf(org) + treasuryDelta, amount);
        assertEq(IERC20(USDC).balanceOf(address(dist)), 0);
        assertEq(IERC20(USDC).allowance(address(dist), ENDAOMENT_FACTORY), 0);
        assertTrue(dist.distributed(token, 0));
    }

    function test_distribute_usesDonateOnceOrgExists() public {
        // Deploy the org out-of-band first: the on-chain code check must route to donate().
        address org = eFactory.computeOrgAddress(ORG_FRESH);
        deal(USDC, address(this), 10e6);
        IERC20(USDC).approve(ENDAOMENT_FACTORY, 10e6);
        eFactory.deployOrgAndDonate(ORG_FRESH, 10e6);
        assertGt(org.code.length, 0);

        _fund(0, 100e6);
        _finalize(causeFresh);
        uint256 before = IERC20(USDC).balanceOf(org);
        dist.distribute(token, 0);
        assertGt(IERC20(USDC).balanceOf(org), before);
        assertEq(IERC20(USDC).allowance(address(dist), org), 0);
    }

    function test_distribute_inactiveDeployedOrgReverts() public {
        _fund(0, 100e6);
        _finalize(causeDeployed);
        // Simulate the registry deactivating the org.
        vm.mockCall(
            ENDAOMENT_REGISTRY,
            abi.encodeCall(IEndaomentRegistry.isActiveEntity, (ORG_DEPLOYED_ADDR)),
            abi.encode(false)
        );
        vm.expectRevert(
            abi.encodeWithSelector(IDonationDistributor.OrgNotActive.selector, ORG_DEPLOYED_ADDR)
        );
        dist.distribute(token, 0);
        assertEq(dist.pending(token, 0), 100e6);
    }
}
