// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEndaomentOrg} from "./interfaces/external/IEndaomentOrg.sol";
import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";

interface IOwned {
    function owner() external view returns (address);
}

/// @title AgentVault
/// @notice USDC donation vault of one curator agent. Anyone can donate; only the agent's signer can
///         give, and only to an unblocked catalogue org inside one of the agent's own cause buckets,
///         through the Endaoment factory. There is no withdrawal and no arbitrary call.
/// @dev Deployed by `CuratorRegistry`; the platform (the registry's owner) sets the per-epoch cap
///      and can pause. Credit is opt-in: `donate(amount, true)` names the donor in `Donated`; plain
///      transfers (including x402 settlements) only add to the balance.
contract AgentVault is IERC1271, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant REGION_SLOTS = 16;
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    ICuratorRegistry public immutable curators;
    uint8 public immutable categoryBit;
    IERC20 public immutable usdc;
    ICauseCatalog public immutable catalog;
    ICauseRegistry public immutable causeRegistry;
    IEndaomentOrgFundFactory public immutable endaomentFactory;

    /// @notice Largest total the agent may give in one epoch (USDC, 6 decimals). Zero: no gifts.
    uint256 public maxGivePerEpoch;
    bool public paused;
    mapping(uint256 epoch => uint256) public givenIn;

    event Donated(address indexed from, uint256 amount, bool credit);
    event Given(
        uint256 indexed epoch,
        uint8 indexed regionBit,
        bytes32 indexed orgId,
        address org,
        uint256 amount
    );
    event MaxGivePerEpochSet(uint256 amount);
    event PausedSet(bool paused);

    error NotSigner(address caller);
    error NotPlatform(address caller);
    error Paused();
    error ZeroAmount();
    error InvalidRegion(uint8 regionBit);
    error NotInBucket(bytes32 orgId);
    error OrgBlocked(bytes32 orgId);
    error EpochCapExceeded(uint256 epoch, uint256 requested, uint256 remaining);
    error OrgAddressMismatch(bytes32 orgId, address expected, address actual);
    error AllowanceNotCleared(address spender);

    constructor(
        ICuratorRegistry curators_,
        uint8 categoryBit_,
        IERC20 usdc_,
        ICauseCatalog catalog_,
        ICauseRegistry causeRegistry_,
        IEndaomentOrgFundFactory endaomentFactory_
    ) {
        curators = curators_;
        categoryBit = categoryBit_;
        usdc = usdc_;
        catalog = catalog_;
        causeRegistry = causeRegistry_;
        endaomentFactory = endaomentFactory_;
    }

    modifier onlyPlatform() {
        if (msg.sender != IOwned(address(curators)).owner()) revert NotPlatform(msg.sender);
        _;
    }

    // ------------------------------------------------------------------ donors

    /// @notice Donates `amount` USDC (approve first). `credit` opts in to being named.
    function donate(uint256 amount, bool credit) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Donated(msg.sender, amount, credit);
    }

    // ------------------------------------------------------------------ agent

    /// @notice Gives `amount` USDC to catalogue org `orgId`, entry `catalogIndex` of the bucket
    ///         `(categoryBit, regionBit)` in the latest catalogue version.
    function give(
        uint8 regionBit,
        bytes32 orgId,
        uint32 catalogIndex,
        bytes32[] calldata proof,
        uint256 amount
    ) external nonReentrant returns (address org) {
        if (msg.sender != curators.signerOf(categoryBit)) {
            revert NotSigner(msg.sender);
        }
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (regionBit >= REGION_SLOTS) revert InvalidRegion(regionBit);

        uint16 bucket = uint16(categoryBit) * REGION_SLOTS + regionBit;
        uint32 version = catalog.latestVersion();
        if (version == 0 || !catalog.verify(version, bucket, catalogIndex, orgId, proof)) {
            revert NotInBucket(orgId);
        }
        if (causeRegistry.isBlocked(keccak256(abi.encode(orgId)))) revert OrgBlocked(orgId);

        uint256 epoch = curators.currentEpoch();
        uint256 used = givenIn[epoch];
        if (used + amount > maxGivePerEpoch) {
            revert EpochCapExceeded(
                epoch, amount, maxGivePerEpoch > used ? maxGivePerEpoch - used : 0
            );
        }
        givenIn[epoch] = used + amount;

        org = endaomentFactory.computeOrgAddress(orgId);
        if (org.code.length == 0) {
            usdc.forceApprove(address(endaomentFactory), amount);
            address deployed = endaomentFactory.deployOrgAndDonate(orgId, amount);
            if (deployed != org) revert OrgAddressMismatch(orgId, org, deployed);
            _requireCleared(address(endaomentFactory));
        } else {
            usdc.forceApprove(org, amount);
            IEndaomentOrg(org).donate(amount);
            _requireCleared(org);
        }
        emit Given(epoch, regionBit, orgId, org, amount);
    }

    /// @inheritdoc IERC1271
    /// @dev Valid when the agent's current signer signed `hash` (used to link this vault as the
    ///      agent's ERC-8004 wallet).
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (
            err == ECDSA.RecoverError.NoError && recovered != address(0)
                && recovered == curators.signerOf(categoryBit)
        ) return ERC1271_MAGIC;
        return 0xffffffff;
    }

    // ------------------------------------------------------------------ platform

    function setMaxGivePerEpoch(uint256 amount) external onlyPlatform {
        maxGivePerEpoch = amount;
        emit MaxGivePerEpochSet(amount);
    }

    function setPaused(bool paused_) external onlyPlatform {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function _requireCleared(address spender) private {
        if (usdc.allowance(address(this), spender) != 0) {
            usdc.forceApprove(spender, 0);
            if (usdc.allowance(address(this), spender) != 0) revert AllowanceNotCleared(spender);
        }
    }
}
