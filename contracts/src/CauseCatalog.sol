// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";

/// @title CauseCatalog
/// @notice Owner-published Merkle commitment to every eligible Endaoment nonprofit, so the whole
///         catalogue (hundreds of thousands of orgs) is eligible for governance without a
///         per-org transaction. Orgs only reach `CauseRegistry` storage when one wins an epoch.
/// @dev Versions are append-only. A version applies to epochs that start after it was set, so
///      the owner cannot change the pool of an epoch that is already running. The snapshot behind
///      each root (org records, categories, full tree) is published at `swarmRefOf(version)` so
///      anyone can rebuild the tree and produce proofs.
contract CauseCatalog is ICauseCatalog, Ownable2Step {
    /// @inheritdoc ICauseCatalog
    uint16 public constant REGION_SLOTS = 16;

    /// @dev Category masks are 64 bits wide.
    uint256 private constant MAX_BUCKETS = 64 * uint256(REGION_SLOTS);

    struct Version {
        bytes32 root;
        bytes32 swarmRef;
        uint64 setAt;
        uint32[] bucketSizes;
    }

    /// @dev Version `v` lives at index `v - 1`.
    Version[] private _versions;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @inheritdoc ICauseCatalog
    function setVersion(bytes32 root, uint32[] calldata bucketSizes, bytes32 swarmRef)
        external
        onlyOwner
        returns (uint32 version)
    {
        if (root == bytes32(0)) revert ZeroRoot();
        uint256 n = bucketSizes.length;
        if (n == 0 || n % REGION_SLOTS != 0 || n > MAX_BUCKETS) revert InvalidBucketCount(n);

        uint256 entries;
        for (uint256 i; i < n; ++i) {
            entries += bucketSizes[i];
        }
        Version storage v = _versions.push();
        v.root = root;
        v.swarmRef = swarmRef;
        v.setAt = uint64(block.timestamp);
        v.bucketSizes = bucketSizes;
        // At most 2^32 versions are reachable; a uint32 version id is ample.
        // forge-lint: disable-next-line(unsafe-typecast)
        version = uint32(_versions.length);
        emit CatalogVersionSet(version, root, swarmRef, entries, v.setAt);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ICauseCatalog
    function latestVersion() external view returns (uint32) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(_versions.length);
    }

    /// @inheritdoc ICauseCatalog
    function versionAt(uint256 timestamp) external view returns (uint32) {
        // `setAt` is non-decreasing: binary search for the last version set before `timestamp`.
        uint256 lo;
        uint256 hi = _versions.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_versions[mid].setAt < timestamp) lo = mid + 1;
            else hi = mid;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(lo);
    }

    /// @inheritdoc ICauseCatalog
    function rootOf(uint32 version) external view returns (bytes32) {
        return _get(version).root;
    }

    /// @inheritdoc ICauseCatalog
    function swarmRefOf(uint32 version) external view returns (bytes32) {
        return _get(version).swarmRef;
    }

    /// @inheritdoc ICauseCatalog
    function setAtOf(uint32 version) external view returns (uint64) {
        return _get(version).setAt;
    }

    /// @inheritdoc ICauseCatalog
    function bucketSizesOf(uint32 version) external view returns (uint32[] memory) {
        return _get(version).bucketSizes;
    }

    /// @inheritdoc ICauseCatalog
    function inFocus(uint16 bucket, uint64 categoryMask, uint16 regionMask)
        public
        pure
        returns (bool)
    {
        uint256 categoryBit = bucket / REGION_SLOTS;
        uint256 regionBit = bucket % REGION_SLOTS;
        return categoryBit < 64 && (categoryMask >> categoryBit) & 1 == 1
            && (regionMask >> regionBit) & 1 == 1;
    }

    /// @inheritdoc ICauseCatalog
    function focusBuckets(uint32 version, uint64 categoryMask, uint16 regionMask)
        public
        view
        returns (uint16[] memory buckets, uint32[] memory sizes)
    {
        uint32[] storage all = _get(version).bucketSizes;
        uint256 n = all.length;
        buckets = new uint16[](n);
        sizes = new uint32[](n);
        uint256 count;
        for (uint256 b; b < n; ++b) {
            // `n <= 1024`, so `b` fits a uint16.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 bucket = uint16(b);
            if (!inFocus(bucket, categoryMask, regionMask)) continue;
            uint32 size = all[b];
            if (size == 0) continue;
            buckets[count] = bucket;
            sizes[count] = size;
            ++count;
        }
        assembly ("memory-safe") {
            mstore(buckets, count)
            mstore(sizes, count)
        }
    }

    /// @inheritdoc ICauseCatalog
    function poolSize(uint32 version, uint64 categoryMask, uint16 regionMask)
        external
        view
        returns (uint256 total)
    {
        if (version == 0) return 0;
        (, uint32[] memory sizes) = focusBuckets(version, categoryMask, regionMask);
        for (uint256 i; i < sizes.length; ++i) {
            total += sizes[i];
        }
    }

    /// @inheritdoc ICauseCatalog
    function locate(uint32 version, uint64 categoryMask, uint16 regionMask, uint256 poolIndex)
        external
        view
        returns (uint16 bucket, uint32 index)
    {
        (uint16[] memory buckets, uint32[] memory sizes) =
            focusBuckets(version, categoryMask, regionMask);
        uint256 rest = poolIndex;
        uint256 total;
        for (uint256 i; i < buckets.length; ++i) {
            if (rest < sizes[i]) {
                // `rest < sizes[i]`, a uint32.
                // forge-lint: disable-next-line(unsafe-typecast)
                return (buckets[i], uint32(rest));
            }
            rest -= sizes[i];
            total += sizes[i];
        }
        revert PoolIndexOutOfRange(poolIndex, total);
    }

    /// @inheritdoc ICauseCatalog
    function verify(
        uint32 version,
        uint16 bucket,
        uint32 index,
        bytes32 orgId,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Version storage v = _get(version);
        if (bucket >= v.bucketSizes.length || index >= v.bucketSizes[bucket]) return false;
        return MerkleProof.verifyCalldata(proof, v.root, leafHash(bucket, index, orgId));
    }

    /// @inheritdoc ICauseCatalog
    function leafHash(uint16 bucket, uint32 index, bytes32 orgId) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(bucket, index, orgId))));
    }

    function _get(uint32 version) private view returns (Version storage) {
        if (version == 0 || version > _versions.length) revert UnknownVersion(version);
        return _versions[version - 1];
    }
}
