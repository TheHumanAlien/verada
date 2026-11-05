// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";

/// @title CauseRegistry
/// @notice Allowlist of nonprofit causes. Causes are never removed, only deactivated, so
///         historical epoch results always resolve to an org. The owner adds or blocks causes
///         directly; the epoch governor materializes catalogue orgs (`CauseCatalog`) on demand
///         when one wins an epoch.
/// @dev Each cause stores the Endaoment org id and the org's CREATE2 address. The address is
///      checked against the Endaoment factory's `computeOrgAddress` whenever it is written, so a
///      mistyped address can never be registered. The org itself may not be deployed yet; the
///      distributor deploys it on first donation.
contract CauseRegistry is ICauseRegistry, Ownable2Step {
    /// @notice Endaoment OrgFundFactory used to derive and verify org addresses.
    IEndaomentOrgFundFactory public immutable endaomentFactory;

    error ZeroAddress();
    error OrgAddressMismatch(bytes32 orgId, address expected, address actual);

    mapping(bytes32 causeId => Cause) private _causes;
    /// @dev Distinguishes "never added" from "added then deactivated".
    mapping(bytes32 causeId => bool) private _exists;
    bytes32[] private _ids;
    mapping(address account => bool) private _materializers;

    constructor(address initialOwner, IEndaomentOrgFundFactory endaomentFactory_)
        Ownable(initialOwner)
    {
        if (address(endaomentFactory_) == address(0)) revert ZeroAddress();
        endaomentFactory = endaomentFactory_;
    }

    /// @inheritdoc ICauseRegistry
    function addCause(
        bytes32 causeId,
        bytes32 orgId,
        address orgAddress,
        string calldata metadataURI
    ) external onlyOwner {
        if (orgId == bytes32(0)) revert ZeroOrgId();
        if (orgAddress == address(0)) revert ZeroPayout();
        if (_exists[causeId]) revert CauseAlreadyExists(causeId);
        _verifyOrg(orgId, orgAddress);

        _store(causeId, orgId, orgAddress, true);
        if (bytes(metadataURI).length != 0) _causes[causeId].metadataURI = metadataURI;

        emit CauseAdded(causeId, orgAddress);
    }

    /// @inheritdoc ICauseRegistry
    function deactivateCause(bytes32 causeId) external onlyOwner {
        if (!_exists[causeId]) revert CauseNotFound(causeId);
        // Idempotent: deactivating twice is a no-op and emits nothing.
        if (!_causes[causeId].active) return;

        _causes[causeId].active = false;
        emit CauseDeactivated(causeId);
    }

    /// @inheritdoc ICauseRegistry
    function blockOrg(bytes32 orgId) external onlyOwner returns (bytes32 causeId) {
        if (orgId == bytes32(0)) revert ZeroOrgId();
        causeId = causeIdOf(orgId);
        if (_exists[causeId]) {
            if (_causes[causeId].active) {
                _causes[causeId].active = false;
                emit CauseDeactivated(causeId);
            }
            return causeId;
        }
        address orgAddress = endaomentFactory.computeOrgAddress(orgId);
        _store(causeId, orgId, orgAddress, false);
        emit CauseAdded(causeId, orgAddress);
        emit CauseDeactivated(causeId);
    }

    /// @inheritdoc ICauseRegistry
    function setMaterializer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _materializers[account] = allowed;
        emit MaterializerSet(account, allowed);
    }

    /// @inheritdoc ICauseRegistry
    function materialize(bytes32 orgId) external returns (bytes32 causeId) {
        if (!_materializers[msg.sender]) revert NotMaterializer(msg.sender);
        if (orgId == bytes32(0)) revert ZeroOrgId();
        causeId = causeIdOf(orgId);
        if (_exists[causeId]) return causeId;
        address orgAddress = endaomentFactory.computeOrgAddress(orgId);
        _store(causeId, orgId, orgAddress, true);
        emit CauseAdded(causeId, orgAddress);
        emit CauseMaterialized(causeId, orgId, orgAddress);
    }

    /// @inheritdoc ICauseRegistry
    /// @dev Sets the org address. It must equal the factory's `computeOrgAddress` for the stored
    ///      org id. Works on deactivated causes too.
    function updatePayout(bytes32 causeId, address newPayout) external onlyOwner {
        if (!_exists[causeId]) revert CauseNotFound(causeId);
        if (newPayout == address(0)) revert ZeroPayout();

        bytes32 orgId = _causes[causeId].orgId;
        if (orgId == bytes32(0)) revert ZeroOrgId();
        _verifyOrg(orgId, newPayout);

        address oldPayout = _causes[causeId].orgAddress;
        _causes[causeId].orgAddress = newPayout;
        emit PayoutUpdated(causeId, oldPayout, newPayout);
    }

    /// @inheritdoc ICauseRegistry
    function getCause(bytes32 causeId) external view returns (Cause memory) {
        if (!_exists[causeId]) revert CauseNotFound(causeId);
        return _causes[causeId];
    }

    /// @inheritdoc ICauseRegistry
    function isActive(bytes32 causeId) external view returns (bool) {
        return _causes[causeId].active;
    }

    /// @inheritdoc ICauseRegistry
    function exists(bytes32 causeId) external view returns (bool) {
        return _exists[causeId];
    }

    /// @inheritdoc ICauseRegistry
    function isBlocked(bytes32 causeId) external view returns (bool) {
        return _exists[causeId] && !_causes[causeId].active;
    }

    /// @inheritdoc ICauseRegistry
    function isMaterializer(address account) external view returns (bool) {
        return _materializers[account];
    }

    /// @notice Cause id of a catalogue org: `keccak256` of its 32-byte org id.
    function causeIdOf(bytes32 orgId) public pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    /// @inheritdoc ICauseRegistry
    function causeCount() external view returns (uint256) {
        return _ids.length;
    }

    /// @inheritdoc ICauseRegistry
    function causeIdAt(uint256 index) external view returns (bytes32) {
        return _ids[index];
    }

    function _store(bytes32 causeId, bytes32 orgId, address orgAddress, bool active) private {
        _exists[causeId] = true;
        _causes[causeId] =
            Cause({orgId: orgId, orgAddress: orgAddress, metadataURI: "", active: active});
        _ids.push(causeId);
    }

    function _verifyOrg(bytes32 orgId, address orgAddress) private view {
        address expected = endaomentFactory.computeOrgAddress(orgId);
        if (expected != orgAddress) revert OrgAddressMismatch(orgId, expected, orgAddress);
    }
}
