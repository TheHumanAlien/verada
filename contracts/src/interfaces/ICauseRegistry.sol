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

    /// @notice Emitted when an account is allowed or disallowed to materialize causes.
    event MaterializerSet(address indexed account, bool allowed);

    /// @notice Emitted when a catalogue org is written to the registry on demand (as active).
    event CauseMaterialized(bytes32 indexed causeId, bytes32 indexed orgId, address payout);

    error NotMaterializer(address caller);
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

    /// @notice Records `orgId` as a deactivated cause whether or not it was ever added, so a
    ///         catalogue org that must not receive funds can never be drawn, pinned or
    ///         materialized. Owner only. Returns its cause id.
    function blockOrg(bytes32 orgId) external returns (bytes32 causeId);

    /// @notice Allows or disallows `account` (the epoch governor) to materialize causes.
    function setMaterializer(address account, bool allowed) external;

    /// @notice Writes catalogue org `orgId` as an active cause with its factory-computed address,
    ///         unless a cause with its id already exists (active or not), which is left untouched.
    ///         Materializers only. Returns the cause id, `keccak256(abi.encode(orgId))`.
    function materialize(bytes32 orgId) external returns (bytes32 causeId);

    /// @notice Whether `causeId` was ever added, materialized or blocked.
    function exists(bytes32 causeId) external view returns (bool);

    /// @notice Whether `causeId` exists and is deactivated (blocked from ballots and payouts).
    function isBlocked(bytes32 causeId) external view returns (bool);

    /// @notice Whether `account` may materialize causes.
    function isMaterializer(address account) external view returns (bool);

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
