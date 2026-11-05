// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {AgentVault} from "../src/AgentVault.sol";
import {CauseRegistry} from "../src/CauseRegistry.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "../src/interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IERC8004IdentityRegistry} from "../src/interfaces/external/IERC8004IdentityRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrg, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {IdentityRegistryMock} from "./mocks/IdentityRegistryMock.sol";
import {CatalogFixture} from "./utils/CatalogFixture.sol";

/// @dev Epoch clock stand-in for the registry (only `currentEpoch` is read).
contract EpochClockMock {
    uint256 public currentEpoch = 5;

    function set(uint256 e) external {
        currentEpoch = e;
    }
}

/// @dev Profile registry stand-in exposing the parent node.
contract ParentNodeMock {
    bytes32 public constant parentNode = keccak256("varada.eth parent");
}

/// @dev Shared deployment of a curator registry over a small catalogue.
abstract contract CuratorBase is Test {
    uint8 internal constant HUNGER = 2;
    uint8 internal constant AFRICA = 0;
    uint8 internal constant ASIA = 1;

    address internal owner = makeAddr("owner");
    uint256 internal signerKey = 0xA11CE;
    address internal signer = vm.addr(0xA11CE);

    IdentityRegistryMock internal identity;
    CatalogFixture internal cat;
    CauseRegistry internal causes;
    MockOrgFactory internal orgFactory;
    MockUSDC internal usdc;
    EpochClockMock internal clock;
    CuratorRegistry internal curators;
    ParentNodeMock internal parent;

    function setUp() public virtual {
        identity = new IdentityRegistryMock();
        usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        causes = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        cat = new CatalogFixture();
        for (uint256 i; i < 4; ++i) {
            cat.add(cat.bucketOf(HUNGER, AFRICA), keccak256(abi.encode("af", i)));
        }
        cat.add(cat.bucketOf(HUNGER, ASIA), keccak256(abi.encode("as", uint256(0))));
        cat.publish();
        clock = new EpochClockMock();
        parent = new ParentNodeMock();
        curators = new CuratorRegistry(
            owner,
            IERC8004IdentityRegistry(address(identity)),
            ICauseCatalog(address(cat.catalog())),
            ICauseRegistry(address(causes)),
            IEndaomentOrgFundFactory(address(orgFactory)),
            IERC20(address(usdc)),
            ITokenProfileRegistry(address(parent))
        );
        vm.prank(owner);
        curators.setGovernor(IEpochGovernor(address(clock)));
    }

    function _register() internal returns (uint256 agentId, address vault) {
        vm.prank(owner);
        (agentId, vault) = curators.registerAgent(
            HUNGER, "hunger", signer, "data:application/json,{}", "Hunger curator"
        );
    }

    function _one(uint8 region, bytes32 root, uint8 count, uint16 weight)
        internal
        pure
        returns (ICuratorRegistry.CurationInput[] memory c)
    {
        c = new ICuratorRegistry.CurationInput[](1);
        c[0] = ICuratorRegistry.CurationInput(region, root, count, weight);
    }
}

contract CuratorRegistryTest is CuratorBase {
    function test_registerAgent_deploysVaultAndIdentity() public {
        (uint256 agentId, address vault) = _register();
        ICuratorRegistry.Agent memory a = curators.agentOf(HUNGER);
        assertEq(a.agentId, agentId);
        assertEq(a.signer, signer);
        assertEq(a.vault, vault);
        assertTrue(a.active);
        assertEq(a.label, "hunger");
        assertEq(a.description, "Hunger curator");
        assertTrue(curators.isRegistered(HUNGER));
        assertEq(identity.ownerOf(agentId), address(curators));
        assertEq(identity.tokenURI(agentId), "data:application/json,{}");
        assertEq(identity.getMetadata(agentId, "verada.category"), abi.encodePacked(HUNGER));
        assertEq(identity.getMetadata(agentId, "verada.vault"), abi.encodePacked(vault));
        assertEq(AgentVault(vault).categoryBit(), HUNGER);
        assertEq(address(AgentVault(vault).curators()), address(curators));
        (bool found, uint8 c) = curators.categoryOfLabelhash(keccak256("hunger"));
        assertTrue(found);
        assertEq(c, HUNGER);
        (found, c) = curators.categoryOfNode(
            keccak256(abi.encodePacked(curators.agentsNode(), keccak256("hunger")))
        );
        assertTrue(found);
        assertEq(c, HUNGER);
        assertEq(
            curators.agentsNode(),
            keccak256(abi.encodePacked(parent.parentNode(), keccak256("agent")))
        );
    }

    function test_registerAgent_guards() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        curators.registerAgent(HUNGER, "hunger", signer, "", "");
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.InvalidCategory.selector, 64));
        curators.registerAgent(64, "x-label", signer, "", "");
        vm.expectRevert(ICuratorRegistry.ZeroAddress.selector);
        curators.registerAgent(HUNGER, "hunger", address(0), "", "");
        vm.expectRevert();
        curators.registerAgent(HUNGER, "Bad Label", signer, "", "");
        curators.registerAgent(HUNGER, "hunger", signer, "", "");
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.AgentExists.selector, HUNGER));
        curators.registerAgent(HUNGER, "food", signer, "", "");
        vm.expectRevert(
            abi.encodeWithSelector(ICuratorRegistry.LabelTaken.selector, keccak256("hunger"))
        );
        curators.registerAgent(3, "hunger", signer, "", "");
        vm.stopPrank();
    }

    function test_setters_onlyOwner_andEffective() public {
        (uint256 agentId,) = _register();
        address s2 = makeAddr("s2");
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        curators.setSigner(HUNGER, s2);
        vm.startPrank(owner);
        curators.setSigner(HUNGER, s2);
        curators.setActive(HUNGER, false);
        curators.setAgentURI(HUNGER, "ipfs://new");
        curators.setDescription(HUNGER, "d2");
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.UnknownAgent.selector, 9));
        curators.setActive(9, true);
        vm.stopPrank();
        assertEq(curators.signerOf(HUNGER), s2);
        assertFalse(curators.agentOf(HUNGER).active);
        assertEq(identity.tokenURI(agentId), "ipfs://new");
        assertEq(curators.agentOf(HUNGER).description, "d2");
    }

    function test_setGovernor_once() public {
        vm.prank(owner);
        vm.expectRevert(ICuratorRegistry.GovernorAlreadySet.selector);
        curators.setGovernor(IEpochGovernor(address(clock)));
    }

    function test_submitCurations_storesForTheNextEpoch() public {
        _register();
        ICuratorRegistry.CurationInput[] memory c = new ICuratorRegistry.CurationInput[](2);
        c[0] = ICuratorRegistry.CurationInput(AFRICA, bytes32("rootA"), 3, 7000);
        c[1] = ICuratorRegistry.CurationInput(ASIA, bytes32("rootS"), 1, 3000);
        vm.expectEmit(true, true, false, true);
        emit ICuratorRegistry.CurationSet(32, 6, bytes32("rootA"), 3, 7000, 1);
        vm.expectEmit(true, true, false, true);
        emit ICuratorRegistry.CurationsSubmitted(HUNGER, 6, 1, bytes32("report"));
        vm.prank(signer);
        curators.submitCurations(HUNGER, 6, 1, bytes32("report"), c);
        ICuratorRegistry.Curation memory got = curators.curationOf(32, 6);
        assertEq(got.picksRoot, bytes32("rootA"));
        assertEq(got.count, 3);
        assertEq(got.weight, 7000);
        assertEq(got.catalogVersion, 1);
        // A resubmission before the epoch starts replaces it.
        vm.prank(signer);
        curators.submitCurations(
            HUNGER, 6, 1, bytes32("report2"), _one(AFRICA, bytes32("r2"), 2, 10)
        );
        assertEq(curators.curationOf(32, 6).picksRoot, bytes32("r2"));
    }

    function test_submitCurations_guards() public {
        _register();
        ICuratorRegistry.CurationInput[] memory ok = _one(AFRICA, bytes32("r"), 1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(ICuratorRegistry.NotSigner.selector, HUNGER, address(this))
        );
        curators.submitCurations(HUNGER, 6, 1, 0, ok);
        vm.startPrank(signer);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.UnknownAgent.selector, 3));
        curators.submitCurations(3, 6, 1, 0, ok);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.NotNextEpoch.selector, 5));
        curators.submitCurations(HUNGER, 5, 1, 0, ok);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.NotNextEpoch.selector, 7));
        curators.submitCurations(HUNGER, 7, 1, 0, ok);
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 2, 0, ok); // unknown catalogue version
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 0, 0, ok);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.InvalidRegion.selector, 8));
        curators.submitCurations(HUNGER, 6, 1, 0, _one(8, bytes32("r"), 1, 1));
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 1, 0, _one(AFRICA, bytes32("r"), 33, 1));
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 1, 0, _one(AFRICA, bytes32("r"), 1, 10_001));
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 1, 0, _one(AFRICA, bytes32(0), 1, 1));
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 1, 0, _one(AFRICA, bytes32("r"), 0, 1));
        ICuratorRegistry.CurationInput[] memory dup = new ICuratorRegistry.CurationInput[](2);
        dup[0] = ok[0];
        dup[1] = ok[0];
        vm.expectRevert(ICuratorRegistry.InvalidCuration.selector);
        curators.submitCurations(HUNGER, 6, 1, 0, dup);
        vm.stopPrank();

        vm.prank(owner);
        curators.setActive(HUNGER, false);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(ICuratorRegistry.AgentInactive.selector, HUNGER));
        curators.submitCurations(HUNGER, 6, 1, 0, ok);
    }

    function test_curationsFor_filters() public {
        _register();
        vm.prank(signer);
        curators.submitCurations(HUNGER, 6, 1, 0, _one(AFRICA, bytes32("r"), 2, 5));
        uint16[] memory buckets = new uint16[](3);
        buckets[0] = 32;
        buckets[1] = 33; // nothing submitted
        buckets[2] = 48; // no agent
        ICuratorRegistry.Curation[] memory got = curators.curationsFor(6, 1, buckets);
        assertEq(got[0].count, 2);
        assertEq(got[1].count, 0);
        assertEq(got[2].count, 0);
        assertEq(curators.curationsFor(6, 2, buckets)[0].count, 0, "other catalogue version");
        assertEq(curators.curationsFor(7, 1, buckets)[0].count, 0, "other epoch");
        vm.prank(owner);
        curators.setActive(HUNGER, false);
        assertEq(curators.curationsFor(6, 1, buckets)[0].count, 0, "inactive agent");
    }

    function test_linkAgentWallet_withVaultErc1271() public {
        (uint256 agentId, address vault) = _register();
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = identity.walletDigest(agentId, vault, address(curators), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        vm.prank(owner);
        curators.linkAgentWallet(HUNGER, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(agentId), vault);
        // A signature by anyone else is rejected by the vault.
        (v, r, s) = vm.sign(0xB0B, digest);
        vm.prank(owner);
        vm.expectRevert(bytes("invalid wallet sig"));
        curators.linkAgentWallet(HUNGER, deadline, abi.encodePacked(r, s, v));
    }

    function test_onERC721Received_onlyFromIdentityRegistry() public {
        vm.expectRevert(ICuratorRegistry.ZeroAddress.selector);
        curators.onERC721Received(address(this), address(0), 1, "");
    }
}

contract AgentVaultTest is CuratorBase {
    AgentVault internal vault;
    address internal donor = makeAddr("donor");

    function setUp() public override {
        super.setUp();
        (, address v) = _register();
        vault = AgentVault(v);
        usdc.mint(donor, 1000e6);
        vm.prank(donor);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(owner);
        vault.setMaxGivePerEpoch(100e6);
    }

    function _proof(uint256 entry)
        internal
        view
        returns (bytes32 orgId, uint32 index, bytes32[] memory proof)
    {
        CatalogFixture.Entry memory e = cat.entryAt(entry);
        return (e.orgId, e.index, cat.proofOf(entry));
    }

    function test_donate_creditIsOptIn() public {
        vm.expectEmit(true, false, false, true);
        emit AgentVault.Donated(donor, 10e6, false);
        vm.prank(donor);
        vault.donate(10e6, false);
        vm.expectEmit(true, false, false, true);
        emit AgentVault.Donated(donor, 5e6, true);
        vm.prank(donor);
        vault.donate(5e6, true);
        assertEq(usdc.balanceOf(address(vault)), 15e6);
        vm.prank(donor);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.donate(0, true);
    }

    function test_give_deploysOrPaysAnInBucketOrg() public {
        vm.prank(donor);
        vault.donate(200e6, false);
        (bytes32 orgId, uint32 index, bytes32[] memory proof) = _proof(1);
        address org = orgFactory.computeOrgAddress(orgId);
        vm.prank(signer);
        assertEq(vault.give(AFRICA, orgId, index, proof, 30e6), org);
        assertGt(org.code.length, 0, "deployed on first gift");
        assertGt(usdc.balanceOf(org), 0);
        // Second gift goes straight to the deployed org.
        vm.prank(signer);
        vault.give(AFRICA, orgId, index, proof, 20e6);
        assertEq(vault.givenIn(5), 50e6);
        assertEq(usdc.allowance(address(vault), org), 0);
        assertEq(usdc.allowance(address(vault), address(orgFactory)), 0);
    }

    function test_give_guards() public {
        vm.prank(donor);
        vault.donate(500e6, false);
        (bytes32 orgId, uint32 index, bytes32[] memory proof) = _proof(0);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotSigner.selector, address(this)));
        vault.give(AFRICA, orgId, index, proof, 1e6);
        vm.startPrank(signer);
        // Same entry claimed in the Asia bucket.
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotInBucket.selector, orgId));
        vault.give(ASIA, orgId, index, proof, 1e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotInBucket.selector, bytes32("other")));
        vault.give(AFRICA, bytes32("other"), index, proof, 1e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.InvalidRegion.selector, 16));
        vault.give(16, orgId, index, proof, 1e6);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.give(AFRICA, orgId, index, proof, 0);
        // The weekly cap.
        vault.give(AFRICA, orgId, index, proof, 100e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.EpochCapExceeded.selector, 5, 1e6, 0));
        vault.give(AFRICA, orgId, index, proof, 1e6);
        vm.stopPrank();
        clock.set(6);
        vm.prank(signer);
        vault.give(AFRICA, orgId, index, proof, 1e6);

        // Blocked orgs and a paused vault.
        vm.prank(owner);
        causes.blockOrg(orgId);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OrgBlocked.selector, orgId));
        vault.give(AFRICA, orgId, index, proof, 1e6);
        vm.prank(owner);
        vault.setPaused(true);
        (bytes32 org2, uint32 index2, bytes32[] memory proof2) = _proof(2);
        vm.prank(signer);
        vm.expectRevert(AgentVault.Paused.selector);
        vault.give(AFRICA, org2, index2, proof2, 1e6);
    }

    function test_platformSetters_onlyRegistryOwner() public {
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotPlatform.selector, address(this)));
        vault.setMaxGivePerEpoch(1);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotPlatform.selector, address(this)));
        vault.setPaused(true);
    }

    function test_isValidSignature_followsTheCurrentSigner() public {
        bytes32 h = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, h);
        assertEq(vault.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(0xB0B, h);
        assertEq(vault.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        assertEq(vault.isValidSignature(h, hex"00"), bytes4(0xffffffff));
        vm.prank(owner);
        curators.setSigner(HUNGER, vm.addr(0xB0B));
        assertEq(vault.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
    }

    /// @dev Funds only ever leave through `give`, to the org the Endaoment factory computes.
    function testFuzz_onlyGiveMovesFunds(uint96 amount, uint96 gift) public {
        amount = uint96(bound(amount, 1, 1000e6));
        vm.prank(donor);
        vault.donate(amount, false);
        gift = uint96(bound(gift, 1, amount < 100e6 ? amount : 100e6));
        (bytes32 orgId, uint32 index, bytes32[] memory proof) = _proof(3);
        vm.prank(signer);
        address org = vault.give(AFRICA, orgId, index, proof, gift);
        assertEq(usdc.balanceOf(address(vault)), amount - gift);
        assertEq(usdc.balanceOf(org) + usdc.balanceOf(makeAddr("treasury")), gift);
    }
}
