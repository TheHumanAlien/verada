// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";

contract CauseRegistryTest is Test {
    CauseRegistry internal registry;
    MockOrgFactory internal factory;
    address internal owner = makeAddr("owner");

    bytes32 internal constant ORG = bytes32("200049703");
    bytes32 internal constant ORG2 = bytes32("873024488");

    function setUp() public {
        MockUSDC usdc = new MockUSDC();
        factory = new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(factory)));
    }

    function _org(bytes32 orgId) internal view returns (address) {
        return factory.computeOrgAddress(orgId);
    }

    function test_constructor_zeroFactoryReverts() public {
        vm.expectRevert(CauseRegistry.ZeroAddress.selector);
        new CauseRegistry(owner, IEndaomentOrgFundFactory(address(0)));
    }

    function test_addCause_storesAndEmits() public {
        bytes32 id = keccak256("EIN-1");
        address org = _org(ORG);
        vm.expectEmit(true, false, false, true);
        emit ICauseRegistry.CauseAdded(id, org);
        vm.prank(owner);
        registry.addCause(id, ORG, org, "ipfs://a");

        ICauseRegistry.Cause memory c = registry.getCause(id);
        assertEq(c.orgId, ORG);
        assertEq(c.orgAddress, org);
        assertEq(c.metadataURI, "ipfs://a");
        assertTrue(c.active);
        assertTrue(registry.isActive(id));
        assertEq(registry.causeCount(), 1);
        assertEq(registry.causeIdAt(0), id);
    }

    function test_addCause_onlyOwner() public {
        address org = _org(ORG);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.addCause(bytes32(uint256(1)), ORG, org, "");
    }

    function test_addCause_revertsZeroOrgId() public {
        address org = _org(ORG);
        vm.prank(owner);
        vm.expectRevert(ICauseRegistry.ZeroOrgId.selector);
        registry.addCause(bytes32(uint256(1)), bytes32(0), org, "");
    }

    function test_addCause_revertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ICauseRegistry.ZeroPayout.selector);
        registry.addCause(bytes32(uint256(1)), ORG, address(0), "");
    }

    function test_addCause_revertsWrongOrgAddress() public {
        address wrong = makeAddr("wrong");
        address right = _org(ORG);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CauseRegistry.OrgAddressMismatch.selector, ORG, right, wrong)
        );
        registry.addCause(bytes32(uint256(1)), ORG, wrong, "");
    }

    function test_addCause_orgAddressOfDifferentOrgRejected() public {
        address a = _org(ORG);
        address b = _org(ORG2);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CauseRegistry.OrgAddressMismatch.selector, ORG, a, b)
        );
        registry.addCause(bytes32(uint256(1)), ORG, b, "");
    }

    function test_addCause_revertsDuplicate_evenIfDeactivated() public {
        bytes32 id = bytes32(uint256(1));
        address org = _org(ORG);
        vm.startPrank(owner);
        registry.addCause(id, ORG, org, "");
        registry.deactivateCause(id);
        vm.expectRevert(abi.encodeWithSelector(ICauseRegistry.CauseAlreadyExists.selector, id));
        registry.addCause(id, ORG, org, "");
        vm.stopPrank();
    }

    function test_deactivate_keepsRecordButInactive() public {
        bytes32 id = bytes32(uint256(1));
        vm.startPrank(owner);
        registry.addCause(id, ORG, _org(ORG), "m");
        vm.expectEmit(true, false, false, false);
        emit ICauseRegistry.CauseDeactivated(id);
        registry.deactivateCause(id);
        // idempotent
        registry.deactivateCause(id);
        vm.stopPrank();

        assertFalse(registry.isActive(id));
        ICauseRegistry.Cause memory c = registry.getCause(id);
        assertEq(c.orgAddress, _org(ORG));
        assertFalse(c.active);
    }

    function test_deactivate_unknownReverts() public {
        bytes32 id = bytes32(uint256(9));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICauseRegistry.CauseNotFound.selector, id));
        registry.deactivateCause(id);
    }

    function test_getCause_unknownReverts() public {
        bytes32 id = bytes32(uint256(9));
        vm.expectRevert(abi.encodeWithSelector(ICauseRegistry.CauseNotFound.selector, id));
        registry.getCause(id);
    }

    function test_updatePayout_sameDerivedAddressEmits() public {
        bytes32 id = bytes32(uint256(1));
        address org = _org(ORG);
        vm.startPrank(owner);
        registry.addCause(id, ORG, org, "");
        vm.expectEmit(true, false, false, true);
        emit ICauseRegistry.PayoutUpdated(id, org, org);
        registry.updatePayout(id, org);
        vm.stopPrank();
    }

    function test_updatePayout_wrongAddressReverts() public {
        bytes32 id = bytes32(uint256(1));
        address bad = makeAddr("bad");
        vm.startPrank(owner);
        registry.addCause(id, ORG, _org(ORG), "");
        vm.expectRevert(
            abi.encodeWithSelector(CauseRegistry.OrgAddressMismatch.selector, ORG, _org(ORG), bad)
        );
        registry.updatePayout(id, bad);
        vm.expectRevert(ICauseRegistry.ZeroPayout.selector);
        registry.updatePayout(id, address(0));
        vm.stopPrank();
    }

    function test_updatePayout_unknownAndNonOwner() public {
        bytes32 id = bytes32(uint256(1));
        address org = _org(ORG);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICauseRegistry.CauseNotFound.selector, id));
        registry.updatePayout(id, org);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.updatePayout(id, org);
    }

    function testFuzz_addCause_acceptsOnlyDerivedAddress(bytes32 orgId, address other) public {
        vm.assume(orgId != bytes32(0));
        address derived = _org(orgId);
        vm.assume(other != derived && other != address(0));
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CauseRegistry.OrgAddressMismatch.selector, orgId, derived, other)
        );
        registry.addCause(bytes32(uint256(1)), orgId, other, "");
        registry.addCause(bytes32(uint256(1)), orgId, derived, "");
        vm.stopPrank();
        assertEq(registry.getCause(bytes32(uint256(1))).orgAddress, derived);
    }

    // ---- catalogue materialization and blocking

    function test_materialize_onlyMaterializer() public {
        address gov = makeAddr("gov");
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(ICauseRegistry.NotMaterializer.selector, gov));
        registry.materialize(ORG);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.setMaterializer(gov, true);
        vm.startPrank(owner);
        vm.expectRevert(CauseRegistry.ZeroAddress.selector);
        registry.setMaterializer(address(0), true);
        vm.expectEmit(true, false, false, true);
        emit ICauseRegistry.MaterializerSet(gov, true);
        registry.setMaterializer(gov, true);
        vm.stopPrank();
        assertTrue(registry.isMaterializer(gov));
    }

    function test_materialize_writesFactoryAddress_andIsIdempotent() public {
        address gov = makeAddr("gov");
        vm.prank(owner);
        registry.setMaterializer(gov, true);
        bytes32 id = registry.causeIdOf(ORG);
        assertEq(id, keccak256(abi.encode(ORG)));
        assertFalse(registry.exists(id));

        vm.expectEmit(true, true, false, true);
        emit ICauseRegistry.CauseMaterialized(id, ORG, _org(ORG));
        vm.prank(gov);
        assertEq(registry.materialize(ORG), id);
        ICauseRegistry.Cause memory c = registry.getCause(id);
        assertEq(c.orgId, ORG);
        assertEq(c.orgAddress, _org(ORG));
        assertTrue(c.active);
        assertEq(registry.causeCount(), 1);

        vm.recordLogs();
        vm.prank(gov);
        registry.materialize(ORG);
        assertEq(vm.getRecordedLogs().length, 0, "second call is a no-op");
        assertEq(registry.causeCount(), 1);

        vm.prank(gov);
        vm.expectRevert(ICauseRegistry.ZeroOrgId.selector);
        registry.materialize(bytes32(0));
    }

    function test_blockOrg_beforeAnyAdd_staysBlocked() public {
        address gov = makeAddr("gov");
        vm.startPrank(owner);
        registry.setMaterializer(gov, true);
        bytes32 id = registry.blockOrg(ORG);
        vm.stopPrank();
        assertTrue(registry.exists(id));
        assertTrue(registry.isBlocked(id));
        assertFalse(registry.isActive(id));
        assertEq(registry.getCause(id).orgAddress, _org(ORG));
        // Materializing never reactivates a blocked org.
        vm.prank(gov);
        registry.materialize(ORG);
        assertTrue(registry.isBlocked(id));
        // Blocking again is a no-op; blocking an active cause deactivates it.
        vm.startPrank(owner);
        registry.blockOrg(ORG);
        registry.addCause(registry.causeIdOf(ORG2), ORG2, _org(ORG2), "");
        vm.expectEmit(true, false, false, false);
        emit ICauseRegistry.CauseDeactivated(registry.causeIdOf(ORG2));
        registry.blockOrg(ORG2);
        vm.expectRevert(ICauseRegistry.ZeroOrgId.selector);
        registry.blockOrg(bytes32(0));
        vm.stopPrank();
        assertTrue(registry.isBlocked(registry.causeIdOf(ORG2)));
    }

    function test_blockOrg_onlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.blockOrg(ORG);
    }
}
