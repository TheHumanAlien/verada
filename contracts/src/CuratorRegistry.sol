// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {AgentVault} from "./AgentVault.sol";
import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IERC8004IdentityRegistry} from "./interfaces/external/IERC8004IdentityRegistry.sol";
import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";
import {LabelLib} from "./libraries/LabelLib.sol";

/// @title CuratorRegistry
/// @notice One curator agent per cause category: its ERC-8004 identity (owned by this contract),
///         its signer (a 1Claw HSM key), its `AgentVault`, and its ENS label under
///         `agent.<parent>`. Agents submit weekly curations for the next epoch, which
///         `EpochGovernor` reads to build ballots.
/// @dev The registry is the source of truth; ERC-8004 is the public identity layer (a Draft
///      standard behind an upgradeable proxy), so nothing here depends on its state after
///      registration. A curation applies to exactly one epoch and can be replaced until that epoch
///      starts, so a running epoch's ballot can never be reshaped.
contract CuratorRegistry is ICuratorRegistry, Ownable2Step, IERC721Receiver {
    /// @inheritdoc ICuratorRegistry
    uint8 public constant MAX_PICKS = 32;
    /// @inheritdoc ICuratorRegistry
    uint16 public constant MAX_WEIGHT = 10_000;

    uint16 internal constant REGION_SLOTS = 16;
    /// @dev Category masks are 64 bits wide.
    uint8 internal constant MAX_CATEGORIES = 64;
    /// @dev Regions in the taxonomy (`packages/sdk/src/catalog.ts`).
    uint8 public constant REGION_COUNT = 8;

    IERC8004IdentityRegistry public immutable identityRegistry;
    ICauseCatalog public immutable catalog;
    ICauseRegistry public immutable causeRegistry;
    IEndaomentOrgFundFactory public immutable endaomentFactory;
    IERC20 public immutable usdc;
    /// @inheritdoc ICuratorRegistry
    bytes32 public immutable agentsNode;

    IEpochGovernor public governor;

    mapping(uint8 categoryBit => Agent) internal _agents;
    mapping(bytes32 labelhash => uint8) internal _categoryPlusOneByLabel;
    mapping(bytes32 node => uint8) internal _categoryPlusOneByNode;
    mapping(uint16 bucket => mapping(uint256 epoch => Curation)) internal _curations;

    /// @param initialOwner The platform.
    /// @param identityRegistry_ ERC-8004 Identity Registry.
    /// @param profileRegistry Token profile registry (for the parent node; the label `agent` must be
    ///        reserved there so no token can take it).
    constructor(
        address initialOwner,
        IERC8004IdentityRegistry identityRegistry_,
        ICauseCatalog catalog_,
        ICauseRegistry causeRegistry_,
        IEndaomentOrgFundFactory endaomentFactory_,
        IERC20 usdc_,
        ITokenProfileRegistry profileRegistry
    ) Ownable(initialOwner) {
        if (
            address(identityRegistry_) == address(0) || address(catalog_) == address(0)
                || address(causeRegistry_) == address(0) || address(endaomentFactory_) == address(0)
                || address(usdc_) == address(0) || address(profileRegistry) == address(0)
        ) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        catalog = catalog_;
        causeRegistry = causeRegistry_;
        endaomentFactory = endaomentFactory_;
        usdc = usdc_;
        agentsNode = keccak256(abi.encodePacked(profileRegistry.parentNode(), keccak256("agent")));
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the epoch governor whose clock curations follow. Once.
    function setGovernor(IEpochGovernor governor_) external onlyOwner {
        if (address(governor) != address(0)) revert GovernorAlreadySet();
        if (address(governor_) == address(0)) revert ZeroAddress();
        governor = governor_;
        emit GovernorSet(address(governor_));
    }

    /// @inheritdoc ICuratorRegistry
    function registerAgent(
        uint8 categoryBit,
        string calldata label,
        address signer,
        string calldata agentURI,
        string calldata description
    ) external onlyOwner returns (uint256 agentId, address vault) {
        if (categoryBit >= MAX_CATEGORIES) {
            revert InvalidCategory(categoryBit);
        }
        if (signer == address(0)) revert ZeroAddress();
        Agent storage a = _agents[categoryBit];
        if (a.vault != address(0)) revert AgentExists(categoryBit);
        bytes32 labelhash = LabelLib.validate(label);
        if (_categoryPlusOneByLabel[labelhash] != 0) revert LabelTaken(labelhash);

        vault = address(
            new AgentVault{salt: bytes32(uint256(categoryBit))}(
                this, categoryBit, usdc, catalog, causeRegistry, endaomentFactory
            )
        );

        IERC8004IdentityRegistry.MetadataEntry[] memory meta =
            new IERC8004IdentityRegistry.MetadataEntry[](2);
        meta[0] = IERC8004IdentityRegistry.MetadataEntry(
            "verada.category", abi.encodePacked(categoryBit)
        );
        meta[1] = IERC8004IdentityRegistry.MetadataEntry("verada.vault", abi.encodePacked(vault));
        agentId = identityRegistry.register(agentURI, meta);

        a.agentId = agentId;
        a.signer = signer;
        a.vault = vault;
        a.active = true;
        a.labelhash = labelhash;
        a.label = label;
        a.description = description;
        _categoryPlusOneByLabel[labelhash] = categoryBit + 1;
        _categoryPlusOneByNode[keccak256(abi.encodePacked(agentsNode, labelhash))] = categoryBit + 1;
        emit AgentRegistered(categoryBit, agentId, label, signer, vault);
    }

    function setSigner(uint8 categoryBit, address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        _agent(categoryBit).signer = signer;
        emit SignerSet(categoryBit, signer);
    }

    /// @notice Pauses or resumes an agent. A paused agent cannot submit, and its curations are
    ///         ignored by the governor (ballots fall back to rotation).
    function setActive(uint8 categoryBit, bool active) external onlyOwner {
        _agent(categoryBit).active = active;
        emit ActiveSet(categoryBit, active);
    }

    function setAgentURI(uint8 categoryBit, string calldata agentURI) external onlyOwner {
        identityRegistry.setAgentURI(_agent(categoryBit).agentId, agentURI);
        emit AgentURISet(categoryBit, agentURI);
    }

    function setDescription(uint8 categoryBit, string calldata description) external onlyOwner {
        _agent(categoryBit).description = description;
        emit DescriptionSet(categoryBit, description);
    }

    /// @notice Links the agent's vault as its ERC-8004 agent wallet. `signature` is the agent
    ///         signer's EIP-712 signature of `AgentWalletSet(agentId, vault, owner = this, deadline)`
    ///         in the Identity Registry's domain; the vault validates it by ERC-1271.
    function linkAgentWallet(uint8 categoryBit, uint256 deadline, bytes calldata signature)
        external
        onlyOwner
    {
        Agent storage a = _agent(categoryBit);
        identityRegistry.setAgentWallet(a.agentId, a.vault, deadline, signature);
        emit AgentWalletLinked(categoryBit, a.vault);
    }

    // ------------------------------------------------------------------ agents

    /// @inheritdoc ICuratorRegistry
    function submitCurations(
        uint8 categoryBit,
        uint256 epoch,
        uint32 catalogVersion,
        bytes32 reportRef,
        CurationInput[] calldata curations
    ) external {
        Agent storage a = _agent(categoryBit);
        if (msg.sender != a.signer) revert NotSigner(categoryBit, msg.sender);
        if (!a.active) revert AgentInactive(categoryBit);
        if (epoch != currentEpoch() + 1) revert NotNextEpoch(epoch);
        if (catalogVersion == 0 || catalogVersion > catalog.latestVersion()) {
            revert InvalidCuration();
        }

        uint256 seen;
        for (uint256 i; i < curations.length; ++i) {
            CurationInput calldata c = curations[i];
            if (c.regionBit >= REGION_COUNT) revert InvalidRegion(c.regionBit);
            if ((seen >> c.regionBit) & 1 == 1) revert InvalidCuration();
            seen |= uint256(1) << c.regionBit;
            if (c.count > MAX_PICKS || c.weight > MAX_WEIGHT) revert InvalidCuration();
            if ((c.count == 0) != (c.picksRoot == bytes32(0))) revert InvalidCuration();

            uint16 bucket = uint16(categoryBit) * REGION_SLOTS + c.regionBit;
            _curations[bucket][epoch] = Curation(c.picksRoot, c.count, c.weight, catalogVersion);
            emit CurationSet(bucket, epoch, c.picksRoot, c.count, c.weight, catalogVersion);
        }
        emit CurationsSubmitted(categoryBit, epoch, catalogVersion, reportRef);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ICuratorRegistry
    function agentOf(uint8 categoryBit) external view returns (Agent memory) {
        return _agents[categoryBit];
    }

    /// @inheritdoc ICuratorRegistry
    function isRegistered(uint8 categoryBit) external view returns (bool) {
        return _agents[categoryBit].vault != address(0);
    }

    /// @inheritdoc ICuratorRegistry
    function signerOf(uint8 categoryBit) external view returns (address) {
        return _agents[categoryBit].signer;
    }

    /// @inheritdoc ICuratorRegistry
    function categoryOfLabelhash(bytes32 labelhash) external view returns (bool, uint8) {
        uint8 c = _categoryPlusOneByLabel[labelhash];
        return c == 0 ? (false, 0) : (true, c - 1);
    }

    /// @inheritdoc ICuratorRegistry
    function categoryOfNode(bytes32 node) external view returns (bool, uint8) {
        uint8 c = _categoryPlusOneByNode[node];
        return c == 0 ? (false, 0) : (true, c - 1);
    }

    /// @inheritdoc ICuratorRegistry
    function curationOf(uint16 bucket, uint256 epoch) external view returns (Curation memory) {
        return _curations[bucket][epoch];
    }

    /// @inheritdoc ICuratorRegistry
    function curationsFor(uint256 epoch, uint32 catalogVersion, uint16[] calldata buckets)
        external
        view
        returns (Curation[] memory out)
    {
        out = new Curation[](buckets.length);
        for (uint256 i; i < buckets.length; ++i) {
            uint16 bucket = buckets[i];
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 categoryBit = uint8(bucket / REGION_SLOTS);
            if (!_agents[categoryBit].active) continue;
            Curation storage c = _curations[bucket][epoch];
            if (c.count == 0 || c.weight == 0 || c.catalogVersion != catalogVersion) continue;
            out[i] = c;
        }
    }

    /// @inheritdoc ICuratorRegistry
    function currentEpoch() public view returns (uint256) {
        if (address(governor) == address(0)) revert GovernorNotSet();
        return governor.currentEpoch();
    }

    /// @inheritdoc IERC721Receiver
    /// @dev Accepts only the agent identities this contract registers.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(identityRegistry)) revert ZeroAddress();
        return IERC721Receiver.onERC721Received.selector;
    }

    function _agent(uint8 categoryBit) internal view returns (Agent storage a) {
        a = _agents[categoryBit];
        if (a.vault == address(0)) revert UnknownAgent(categoryBit);
    }
}
