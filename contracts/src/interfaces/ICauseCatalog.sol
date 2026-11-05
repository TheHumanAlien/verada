// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ICauseCatalog
/// @notice Versioned Merkle commitment to every eligible nonprofit, grouped into buckets of
///         `category x region`. A leaf is `(uint16 bucket, uint32 index, bytes32 orgId)` hashed as
///         an OpenZeppelin standard Merkle tree leaf; entries of a bucket are numbered
///         `0..bucketSize-1` in ascending orgId order. An org appears once in every bucket it
///         belongs to.
/// @dev `bucket = categoryBit * REGION_SLOTS + regionBit`. A focus is a pair of masks
///      (`uint64` categories, `uint16` regions); its pool is the concatenation, in ascending
///      bucket order, of every non-empty bucket inside it.
interface ICauseCatalog {
    /// @notice Emitted when a catalogue version is published. It applies to epochs starting
    ///         after `setAt`.
    event CatalogVersionSet(
        uint32 indexed version, bytes32 root, bytes32 swarmRef, uint256 entries, uint64 setAt
    );

    error ZeroRoot();
    error InvalidBucketCount(uint256 count);
    error UnknownVersion(uint32 version);
    error PoolIndexOutOfRange(uint256 poolIndex, uint256 poolSize);

    /// @notice Region slots per category in the bucket layout.
    function REGION_SLOTS() external view returns (uint16);

    /// @notice Publishes a new catalogue version. Owner only.
    /// @param root Merkle root of the catalogue.
    /// @param bucketSizes Entries per bucket; length a multiple of `REGION_SLOTS`, at most
    ///        `64 * REGION_SLOTS`.
    /// @param swarmRef Swarm reference of the published snapshot (files and full tree).
    function setVersion(bytes32 root, uint32[] calldata bucketSizes, bytes32 swarmRef)
        external
        returns (uint32 version);

    /// @notice Latest version (zero before the first).
    function latestVersion() external view returns (uint32);

    /// @notice Latest version set strictly before `timestamp` (zero if none).
    function versionAt(uint256 timestamp) external view returns (uint32);

    function rootOf(uint32 version) external view returns (bytes32);
    function swarmRefOf(uint32 version) external view returns (bytes32);
    function setAtOf(uint32 version) external view returns (uint64);
    function bucketSizesOf(uint32 version) external view returns (uint32[] memory);

    /// @notice Whether `bucket` lies inside the focus `(categoryMask, regionMask)`.
    function inFocus(uint16 bucket, uint64 categoryMask, uint16 regionMask)
        external
        pure
        returns (bool);

    /// @notice Non-empty buckets of a focus with their sizes, in ascending bucket order.
    function focusBuckets(uint32 version, uint64 categoryMask, uint16 regionMask)
        external
        view
        returns (uint16[] memory buckets, uint32[] memory sizes);

    /// @notice Number of entries in a focus pool.
    function poolSize(uint32 version, uint64 categoryMask, uint16 regionMask)
        external
        view
        returns (uint256);

    /// @notice Bucket and in-bucket index of entry `poolIndex` of a focus pool.
    function locate(uint32 version, uint64 categoryMask, uint16 regionMask, uint256 poolIndex)
        external
        view
        returns (uint16 bucket, uint32 index);

    /// @notice Whether `(bucket, index, orgId)` is an entry of `version`.
    function verify(
        uint32 version,
        uint16 bucket,
        uint32 index,
        bytes32 orgId,
        bytes32[] calldata proof
    ) external view returns (bool);

    /// @notice Leaf hash of an entry (OpenZeppelin standard Merkle tree encoding).
    function leafHash(uint16 bucket, uint32 index, bytes32 orgId) external pure returns (bytes32);
}
