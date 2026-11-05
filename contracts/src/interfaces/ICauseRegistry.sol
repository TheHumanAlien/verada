// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ICauseRegistry
/// @notice Allowlist of nonprofit causes eligible to receive funds.
interface ICauseRegistry {
    /// @notice A registered cause.
    /// @param orgId Endaoment org id: bytes32 of the EIN digits (no hyphen), left-aligned.
    /// @param orgAddress CREATE2 address of the Endaoment org entity (may not be deployed yet).
    /// @param metadataURI Cause metadata URI.
    /// @param active Whether the cause can currently be voted for and paid.
    struct Cause {
        bytes32 orgId;
        address orgAddress;
        string metadataURI;
        bool active;
    }

    /// @notice Emitted when a cause is added.
    event CauseAdded(bytes32 indexed causeId, address payout);
    /// @dev `payout` in CauseAdded/PayoutUpdated is the org's CREATE2 address.

    /// @notice Emitted when a cause is deactivated.
    event CauseDeactivated(bytes32 indexed causeId);

    /// @notice Emitted when a cause's payout address changes.
    event PayoutUpdated(bytes32 indexed causeId, address oldPayout, address newPayout);

    error CauseAlreadyExists(bytes32 causeId);
    error CauseNotFound(bytes32 causeId);
    error ZeroPayout();
    error ZeroOrgId();

    /// @notice Adds a cause. `causeId` is the keccak256 of the nonprofit's organization id string.
    ///         `orgAddress` is the org's CREATE2 address (factory.computeOrgAddress(orgId)).
    function addCause(
        bytes32 causeId,
        bytes32 orgId,
        address orgAddress,
        string calldata metadataURI
    ) external;

    /// @notice Deactivates a cause.
    function deactivateCause(bytes32 causeId) external;

    /// @notice Changes a cause's org address (for example if the org was re-derived).
    function updatePayout(bytes32 causeId, address newPayout) external;

    /// @notice Returns a cause.
    function getCause(bytes32 causeId) external view returns (Cause memory);

    /// @notice Whether `causeId` exists and is active.
    function isActive(bytes32 causeId) external view returns (bool);

    /// @notice Number of causes ever added.
    function causeCount() external view returns (uint256);

    /// @notice Cause id at `index` in insertion order.
    function causeIdAt(uint256 index) external view returns (bytes32);
}
