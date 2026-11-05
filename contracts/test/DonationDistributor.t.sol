// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {DonationDistributor} from "../src/DonationDistributor.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {IDonationDistributor} from "../src/interfaces/IDonationDistributor.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrg, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";
import {CatalogFixture} from "./utils/CatalogFixture.sol";

contract DonationDistributorTest is Test {
    uint256 internal constant WEEK = 7 days;

    MockUSDC internal usdc;
    MockEndaomentRegistry internal eReg;
    MockOrgFactory internal eFactory;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    EpochGovernor internal gov;
    DonationDistributor internal dist;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal vault = makeAddr("vault");
    address internal voter = makeAddr("voter");
    address internal treasury = makeAddr("treasury");
    bytes32 internal constant ORG_A = bytes32("200049703");
    bytes32 internal constant ORG_B = bytes32("873024488");
    // Catalogue causes: neither is in the registry until it wins an epoch.
    bytes32 internal causeA = keccak256(abi.encode(ORG_A));
    bytes32 internal causeB = keccak256(abi.encode(ORG_B));

    function setUp() public {
        // The token launches mid-week and a holder is funded; the governor is deployed a week
        // later so epoch 0's snapshot falls after the holder received its balance.
        vm.warp(1_750_000_123);
        VeradaToken tokenContract =
            new VeradaToken("Verada Test", "VTEST", "ipfs://meta", makeAddr("creator"), factory);
        token = address(tokenContract);
        vm.prank(factory);
        tokenContract.transfer(voter, 1000e18);
        vm.warp(block.timestamp + WEEK);

        usdc = new MockUSDC();
        eReg = new MockEndaomentRegistry(address(usdc), treasury);
        eFactory = new MockOrgFactory(eReg);
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(eFactory)));
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(2);
        profiles = new MockProfileRegistryLite();
        CatalogFixture cat = new CatalogFixture();
        cat.add(cat.bucketOf(2, 0), ORG_A);
        cat.add(cat.bucketOf(2, 0), ORG_B);
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
        dist = new DonationDistributor(
            owner, gov, registry, IEndaomentOrgFundFactory(address(eFactory))
        );

        vm.startPrank(owner);
        gov.setFactory(factory);
        dist.setFeeVault(vault);
        registry.setMaterializer(address(gov), true);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        IEpochGovernor.Pin[] memory pins = new IEpochGovernor.Pin[](2);
        pins[0] = cat.pin(0);
        pins[1] = cat.pin(1);
        vm.prank(makeAddr("creator"));
        gov.setShortlist(token, pins);

        // Org A is already deployed; org B is not.
        eFactory.deployOrg(ORG_A);
    }

    function _fund(uint256 epoch, uint256 amount) internal {
        usdc.mint(address(dist), amount);
        vm.prank(vault);
        dist.receiveFunds(token, epoch, amount);
    }

    function _finalizeEpoch0(bytes32 cause) internal {
        uint8 choice = cause == causeA ? 0 : 1;
        if (!gov.isPrepared(token, 0)) gov.openEpoch(token, 0);
        vm.prank(voter);
        scheme.castBallot(address(gov), token, 0, abi.encode(choice));
        vm.warp(gov.epochStart(1));
        gov.closeEpoch(token, 0);
        scheme.finalizeFromBallots(address(gov), token, 0);
        gov.finalizeEpoch(token, 0);
    }

    function _orgA() internal view returns (address) {
        return eFactory.computeOrgAddress(ORG_A);
    }

    function _orgB() internal view returns (address) {
        return eFactory.computeOrgAddress(ORG_B);
    }

    // ---- setup / auth

    function test_constructor_readsEndaomentConfig() public view {
        assertEq(dist.settlementAsset(), address(usdc));
        assertEq(address(dist.endaomentRegistry()), address(eReg));
    }

    function test_constructor_zeroArgsRevert() public {
        IEndaomentOrgFundFactory f = IEndaomentOrgFundFactory(address(eFactory));
        vm.expectRevert(DonationDistributor.ZeroAddress.selector);
        new DonationDistributor(owner, gov, registry, IEndaomentOrgFundFactory(address(0)));
        vm.expectRevert(DonationDistributor.ZeroAddress.selector);
        new DonationDistributor(owner, gov, CauseRegistry(address(0)), f);
    }

    function test_setFeeVault_onceAndOnlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        dist.setFeeVault(address(1));
        vm.prank(owner);
        vm.expectRevert(DonationDistributor.FeeVaultAlreadySet.selector);
        dist.setFeeVault(address(1));
    }

    function test_receiveFunds_onlyVault() public {
        vm.expectRevert(IDonationDistributor.NotFeeVault.selector);
        dist.receiveFunds(token, 0, 1);
    }

    function test_receiveFunds_requiresBackingBalance() public {
        vm.prank(vault);
        vm.expectRevert(DonationDistributor.InsufficientBalance.selector);
        dist.receiveFunds(token, 0, 1);
    }

    function test_receiveFunds_accumulatesAndZeroIsNoop() public {
        _fund(0, 100);
        _fund(0, 50);
        vm.prank(vault);
        dist.receiveFunds(token, 0, 0);
        assertEq(dist.pending(token, 0), 150);
        assertEq(dist.reserved(), 150);
    }

    function test_reserved_preventsDoubleCountingSharedBalance() public {
        _fund(0, 100);
        vm.prank(vault);
        vm.expectRevert(DonationDistributor.InsufficientBalance.selector);
        dist.receiveFunds(token, 1, 1);
    }

    // ---- distribute: deployed org

    function test_distribute_deployedOrg_donates() public {
        _fund(0, 1000e6);
        _finalizeEpoch0(causeA);
        address org = _orgA();

        vm.expectEmit(true, true, true, true);
        emit IDonationDistributor.Donated(token, 0, causeA, org, 1000e6);
        dist.distribute(token, 0);

        // 1.5% fee to treasury, remainder to org.
        assertEq(usdc.balanceOf(treasury), 15e6);
        assertEq(usdc.balanceOf(org), 985e6);
        assertEq(MockOrg(org).balance(), 985e6);
        assertEq(usdc.balanceOf(address(dist)), 0);
        assertEq(usdc.allowance(address(dist), org), 0);
        assertTrue(dist.distributed(token, 0));
        assertEq(dist.pending(token, 0), 0);
        assertEq(dist.reserved(), 0);
    }

    function test_distribute_deployedButInactiveReverts_andIsRetryable() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeA);
        eReg.setActive(_orgA(), false);

        vm.expectRevert(abi.encodeWithSelector(IDonationDistributor.OrgNotActive.selector, _orgA()));
        dist.distribute(token, 0);
        assertFalse(dist.distributed(token, 0));
        assertEq(dist.pending(token, 0), 100e6);

        eReg.setActive(_orgA(), true);
        dist.distribute(token, 0);
        assertTrue(dist.distributed(token, 0));
    }

    function test_distribute_readsCurrentFee() public {
        eReg.setFee(300);
        assertEq(dist.endaomentFeeFor(_orgA()), 300);
        _fund(0, 1000e6);
        _finalizeEpoch0(causeA);
        dist.distribute(token, 0);
        assertEq(usdc.balanceOf(treasury), 30e6);
        assertEq(usdc.balanceOf(_orgA()), 970e6);
    }

    // ---- distribute: undeployed org

    function test_distribute_undeployedOrg_deploysAndDonates() public {
        _fund(0, 1000e6);
        _finalizeEpoch0(causeB);
        address org = _orgB();
        assertEq(org.code.length, 0);

        vm.expectEmit(true, true, false, false);
        emit IDonationDistributor.OrgDeployed(ORG_B, org);
        vm.expectEmit(true, true, true, true);
        emit IDonationDistributor.Donated(token, 0, causeB, org, 1000e6);
        dist.distribute(token, 0);

        assertGt(org.code.length, 0);
        assertEq(usdc.balanceOf(org), 985e6);
        assertEq(usdc.balanceOf(treasury), 15e6);
        assertEq(usdc.allowance(address(dist), address(eFactory)), 0);
        assertTrue(dist.distributed(token, 0));
    }

    function test_distribute_raceDeployedBetweenEpochs_usesDonate() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeB);
        // Someone deploys org B before distribution; the on-chain code check must pick donate().
        eFactory.deployOrg(ORG_B);
        dist.distribute(token, 0);
        assertEq(usdc.balanceOf(_orgB()), 98_500_000);
    }

    function test_distribute_factoryReturnsWrongOrgReverts() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeB);
        eFactory.setLie(makeAddr("lie"));
        vm.expectRevert();
        dist.distribute(token, 0);
        assertFalse(dist.distributed(token, 0));
    }

    // ---- guards

    function test_distribute_beforeFinalizeReverts() public {
        _fund(0, 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(IDonationDistributor.EpochNotFinalized.selector, token, 0)
        );
        dist.distribute(token, 0);
    }

    function test_distribute_twiceReverts() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeA);
        dist.distribute(token, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IDonationDistributor.AlreadyDistributed.selector, token, 0)
        );
        dist.distribute(token, 0);
    }

    function test_distribute_nothingReverts() public {
        _finalizeEpoch0(causeA);
        vm.expectRevert(
            abi.encodeWithSelector(IDonationDistributor.NothingToDistribute.selector, token, 0)
        );
        dist.distribute(token, 0);
    }

    function test_receiveFunds_afterDistributeReverts() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeA);
        dist.distribute(token, 0);
        usdc.mint(address(dist), 5);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(IDonationDistributor.AlreadyDistributed.selector, token, 0)
        );
        dist.receiveFunds(token, 0, 5);
    }

    function test_distribute_paysEvenIfCauseDeactivatedAfterwards() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeA);
        // The winner was materialized into the registry at finalization.
        assertTrue(registry.isActive(causeA));
        assertEq(registry.getCause(causeA).orgAddress, _orgA());
        vm.prank(owner);
        registry.deactivateCause(causeA);
        dist.distribute(token, 0);
        assertEq(usdc.balanceOf(_orgA()), 98_500_000);
    }

    function test_distribute_epochsAreIndependent() public {
        _fund(0, 100e6);
        _fund(1, 40e6);
        _finalizeEpoch0(causeA);
        dist.distribute(token, 0);
        assertEq(dist.pending(token, 1), 40e6);
        assertEq(dist.reserved(), 40e6);
        assertEq(usdc.balanceOf(address(dist)), 40e6);
    }

    function test_distribute_feeAboveOneHundredPercentRevertsAtomically() public {
        _fund(0, 100e6);
        _finalizeEpoch0(causeA);
        eReg.setFee(10_001);
        vm.expectRevert();
        dist.distribute(token, 0);
        assertEq(dist.pending(token, 0), 100e6);
        assertEq(dist.reserved(), 100e6);
        assertFalse(dist.distributed(token, 0));
    }

    function testFuzz_distribute_conservesFunds(uint96 a, uint32 fee, bool pickB) public {
        a = uint96(bound(a, 1, 1e15));
        fee = uint32(bound(fee, 0, 10_000));
        eReg.setFee(fee);
        _fund(0, a);
        _finalizeEpoch0(pickB ? causeB : causeA);
        dist.distribute(token, 0);
        address org = pickB ? _orgB() : _orgA();
        assertEq(usdc.balanceOf(org) + usdc.balanceOf(treasury), a);
        assertEq(usdc.balanceOf(address(dist)), 0);
        assertEq(dist.reserved(), 0);
        assertEq(usdc.allowance(address(dist), org), 0);
    }

    function test_feesButNoVotes_paidToDefaultCause() public {
        _fund(0, 100e6);
        vm.startPrank(owner);
        registry.addCause(causeA, ORG_A, eFactory.computeOrgAddress(ORG_A), "a");
        gov.setDefaultCause(causeA);
        vm.stopPrank();
        vm.warp(gov.epochZeroStart() + WEEK);
        gov.finalizeEpoch(token, 0);
        dist.distribute(token, 0);
        assertEq(usdc.balanceOf(_orgA()), 98_500_000);
    }
}
