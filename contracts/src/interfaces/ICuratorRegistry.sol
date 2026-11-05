// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ICuratorRegistry
/// @notice One curator agent per cause category, named `<label>.agent.<parent>`. Each week an
///         agent submits, for the next epoch, per region: a Merkle root of up to `MAX_PICKS` ranked
///         catalogue picks and an urgency weight. `EpochGovernor` reads them to build ballots.
/// @dev A pick leaf is the OpenZeppelin standard-tree leaf of
///      `(uint8 rank, uint32 catalogIndex, bytes32 orgId)`; ranks run `0..count-1`. Picks are not
///      checked on submission: the governor skips any pick whose catalogue entry is not that org.
interface ICuratorRegistry {
    struct Agent {
        uint256 agentId;
        address signer;
        address vault;
        bool active;
        bytes32 labelhash;
        string label;
        string description;
    }

    struct Curation {
        bytes32 picksRoot;
        uint8 count;
        uint16 weight;
        uint32 catalogVersion;
    }

    struct CurationInput {
        uint8 regionBit;
        bytes32 picksRoot;
        uint8 count;
        uint16 weight;
    }

    event AgentRegistered(
        uint8 indexed categoryBit,
        uint256 indexed agentId,
        string label,
        address signer,
        address vault
    );
    event SignerSet(uint8 indexed categoryBit, address signer);
    event ActiveSet(uint8 indexed categoryBit, bool active);
    event AgentURISet(uint8 indexed categoryBit, string agentURI);
    event DescriptionSet(uint8 indexed categoryBit, string description);
    event AgentWalletLinked(uint8 indexed categoryBit, address wallet);
    event GovernorSet(address governor);
    /// @notice One per region in a weekly submission; `reportRef` is the Swarm reference of the
    ///         full report (picks with scores, reasons, sources, and the newsletter).
    event CurationSet(
        uint16 indexed bucket,
        uint256 indexed epoch,
        bytes32 picksRoot,
        uint8 count,
        uint16 weight,
        uint32 catalogVersion
    );
    event CurationsSubmitted(
        uint8 indexed categoryBit, uint256 indexed epoch, uint32 catalogVersion, bytes32 reportRef
    );

    error ZeroAddress();
    error UnknownAgent(uint8 categoryBit);
    error AgentExists(uint8 categoryBit);
    error LabelTaken(bytes32 labelhash);
    error InvalidCategory(uint8 categoryBit);
    error InvalidRegion(uint8 regionBit);
    error NotSigner(uint8 categoryBit, address caller);
    error AgentInactive(uint8 categoryBit);
    error NotNextEpoch(uint256 epoch);
    error InvalidCuration();
    error GovernorAlreadySet();
    error GovernorNotSet();

    function MAX_PICKS() external view returns (uint8);
    function MAX_WEIGHT() external view returns (uint16);

    function registerAgent(
        uint8 categoryBit,
        string calldata label,
        address signer,
        string calldata agentURI,
        string calldata description
    ) external returns (uint256 agentId, address vault);

    function submitCurations(
        uint8 categoryBit,
        uint256 epoch,
        uint32 catalogVersion,
        bytes32 reportRef,
        CurationInput[] calldata curations
    ) external;

    function agentOf(uint8 categoryBit) external view returns (Agent memory);
    function isRegistered(uint8 categoryBit) external view returns (bool);
    function signerOf(uint8 categoryBit) external view returns (address);
    function categoryOfLabelhash(bytes32 labelhash)
        external
        view
        returns (bool found, uint8 categoryBit);
    function categoryOfNode(bytes32 node) external view returns (bool found, uint8 categoryBit);
    /// @notice Namehash of `agent.<parent>`.
    function agentsNode() external view returns (bytes32);

    function curationOf(uint16 bucket, uint256 epoch) external view returns (Curation memory);

    /// @notice Usable curations of `buckets` for `epoch` under `catalogVersion`: zeroed for a bucket
    ///         with no agent, an inactive agent, nothing submitted, or another catalogue version.
    function curationsFor(uint256 epoch, uint32 catalogVersion, uint16[] calldata buckets)
        external
        view
        returns (Curation[] memory);

    function currentEpoch() external view returns (uint256);
}
