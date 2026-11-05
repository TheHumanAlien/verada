// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";

/// @dev Builds small catalogue Merkle trees in Solidity (sorted-pair hashing, so OpenZeppelin's
///      `MerkleProof` accepts them; the layout need not match the JS builder's) and turns entries
///      into the governor's `Pin` and `Draw` structs.
library CatalogTree {
    /// @dev Leaf hashes layer by layer; layer 0 is the leaves in entry order.
    function layers(bytes32[] memory leaves) internal pure returns (bytes32[][] memory out) {
        uint256 depth = 1;
        for (uint256 n = leaves.length; n > 1; n = (n + 1) / 2) {
            ++depth;
        }
        out = new bytes32[][](depth);
        out[0] = leaves;
        for (uint256 d = 1; d < depth; ++d) {
            bytes32[] memory prev = out[d - 1];
            bytes32[] memory next = new bytes32[]((prev.length + 1) / 2);
            for (uint256 i; i < next.length; ++i) {
                uint256 l = 2 * i;
                next[i] = l + 1 < prev.length
                    ? Hashes.commutativeKeccak256(prev[l], prev[l + 1])
                    : prev[l];
            }
            out[d] = next;
        }
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[][] memory ls = layers(leaves);
        return ls[ls.length - 1][0];
    }

    function proof(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32[] memory p)
    {
        bytes32[][] memory ls = layers(leaves);
        bytes32[] memory tmp = new bytes32[](ls.length);
        uint256 n;
        uint256 i = index;
        for (uint256 d; d + 1 < ls.length; ++d) {
            uint256 sib = i ^ 1;
            if (sib < ls[d].length) tmp[n++] = ls[d][sib];
            i /= 2;
        }
        p = new bytes32[](n);
        for (uint256 k; k < n; ++k) {
            p[k] = tmp[k];
        }
    }
}

/// @dev A catalogue under test: entries, their leaves and published versions. The fixture owns
///      the catalogue and publishes on request.
contract CatalogFixture {
    uint16 internal constant REGION_SLOTS = 16;
    /// @dev Matches the SDK taxonomy: 21 categories.
    uint256 internal constant BUCKETS = 21 * 16;

    CauseCatalog public immutable catalog;

    struct Entry {
        uint16 bucket;
        uint32 index;
        bytes32 orgId;
    }

    Entry[] internal _entries;
    bytes32[] internal _leaves;
    uint32[] internal _sizes;

    constructor() {
        catalog = new CauseCatalog(address(this));
        _sizes = new uint32[](BUCKETS);
    }

    /// @dev Publishes the entries added so far as a new version.
    function publish() external returns (uint32) {
        return catalog.setVersion(root(), _sizes, keccak256(abi.encode("swarm", _leaves.length)));
    }

    function bucketOf(uint256 categoryBit, uint256 regionBit) public pure returns (uint16) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(categoryBit * REGION_SLOTS + regionBit);
    }

    /// @dev Appends `orgId` as the next entry of `bucket`. Callers add entries of a bucket in
    ///      ascending orgId order only if they care about matching the JS builder; the contracts
    ///      only need indices to be contiguous.
    function add(uint16 bucket, bytes32 orgId) public returns (uint32 index) {
        index = _sizes[bucket]++;
        _entries.push(Entry(bucket, index, orgId));
        _leaves.push(catalog.leafHash(bucket, index, orgId));
    }

    function root() public view returns (bytes32) {
        return CatalogTree.root(_leaves);
    }

    function sizes() external view returns (uint32[] memory) {
        return _sizes;
    }

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function entryAt(uint256 i) external view returns (Entry memory) {
        return _entries[i];
    }

    /// @dev Entry `(bucket, index)`; reverts if absent.
    function find(uint16 bucket, uint32 index) public view returns (uint256 i) {
        for (; i < _entries.length; ++i) {
            if (_entries[i].bucket == bucket && _entries[i].index == index) return i;
        }
        revert("no such entry");
    }

    function proofOf(uint256 entry) public view returns (bytes32[] memory) {
        return CatalogTree.proof(_leaves, entry);
    }

    function pin(uint256 entry) public view returns (IEpochGovernor.Pin memory p) {
        Entry memory e = _entries[entry];
        p = IEpochGovernor.Pin({
            orgId: e.orgId, bucket: e.bucket, index: e.index, proof: proofOf(entry)
        });
    }

    /// @dev The draws a correct filler supplies for `token`'s ballot in `epoch`, computed the way
    ///      the governor does (sequential walk or hash draws, skipping repeats and blocked
    ///      causes).
    function draws(
        IEpochGovernor gov,
        ICauseRegistry registry,
        address token,
        uint256 epoch,
        uint64 categoryMask,
        uint16 regionMask
    ) external view returns (IEpochGovernor.Draw[] memory out) {
        (uint32 version, uint256 pool) = gov.poolOf(token, epoch);
        out = new IEpochGovernor.Draw[](0);
        if (version == 0 || pool == 0) return out;
        bytes32[] memory pins = gov.shortlistFor(token, epoch);
        bytes32[] memory taken = new bytes32[](pins.length);
        uint256 m;
        for (uint256 i; i < pins.length; ++i) {
            if (!registry.isBlocked(pins[i])) taken[m++] = pins[i];
        }
        assembly ("memory-safe") {
            mstore(taken, m)
        }
        return drawsAfter(gov, registry, token, epoch, categoryMask, regionMask, taken);
    }

    /// @dev Rotation draws after `taken` (cause ids already on the ballot: pins and curated picks).
    function drawsAfter(
        IEpochGovernor gov,
        ICauseRegistry registry,
        address token,
        uint256 epoch,
        uint64 categoryMask,
        uint16 regionMask,
        bytes32[] memory taken
    ) public view returns (IEpochGovernor.Draw[] memory out) {
        (uint32 version, uint256 pool) = gov.poolOf(token, epoch);
        out = new IEpochGovernor.Draw[](0);
        if (version == 0 || pool == 0) return out;
        uint256 size = gov.ballotSize();
        bytes32[] memory opts = new bytes32[](size);
        uint256 n;
        for (uint256 i; i < taken.length && n < size; ++i) {
            opts[n++] = taken[i];
        }
        if (n >= size) return out;
        uint256 slots = size - n;
        bool sequential = pool <= slots;
        uint256 budget = sequential ? pool : gov.DRAW_FACTOR() * slots;
        IEpochGovernor.Draw[] memory tmp = new IEpochGovernor.Draw[](budget);
        uint256 k;
        for (; k < budget && n < size; ++k) {
            uint256 idx = sequential ? k : gov.drawIndex(token, epoch, version, k, pool);
            (uint16 bucket, uint32 index) = catalog.locate(version, categoryMask, regionMask, idx);
            uint256 e = find(bucket, index);
            bytes32 orgId = _entries[e].orgId;
            tmp[k] = IEpochGovernor.Draw({orgId: orgId, proof: proofOf(e)});
            bytes32 causeId = keccak256(abi.encode(orgId));
            bool dup;
            for (uint256 j; j < n; ++j) {
                if (opts[j] == causeId) dup = true;
            }
            if (dup || registry.isBlocked(causeId)) continue;
            opts[n++] = causeId;
        }
        out = new IEpochGovernor.Draw[](k);
        for (uint256 i; i < k; ++i) {
            out[i] = tmp[i];
        }
    }
}

/// @dev For fork tests that use the deployed catalogue: publishes `orgs` as entries 0..n-1 of the
///      hunger x Africa bucket (category bit 2, region bit 0) and returns the leaves for proofs.
library CatalogPublish {
    uint16 internal constant BUCKET = 2 * 16;
    uint64 internal constant CATEGORIES = uint64(1) << 2;
    uint16 internal constant REGIONS = uint16(1);

    function publish(CauseCatalog catalog, bytes32[] memory orgs)
        internal
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](orgs.length);
        for (uint256 i; i < orgs.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            leaves[i] = catalog.leafHash(BUCKET, uint32(i), orgs[i]);
        }
        uint32[] memory sizes = new uint32[](21 * 16);
        // forge-lint: disable-next-line(unsafe-typecast)
        sizes[BUCKET] = uint32(orgs.length);
        catalog.setVersion(CatalogTree.root(leaves), sizes, bytes32(uint256(1)));
    }

    /// @dev The sequential draws of a pool no larger than the ballot: every entry in order.
    function allDraws(bytes32[] memory orgs, bytes32[] memory leaves)
        internal
        pure
        returns (IEpochGovernor.Draw[] memory d)
    {
        d = new IEpochGovernor.Draw[](orgs.length);
        for (uint256 i; i < orgs.length; ++i) {
            d[i] = IEpochGovernor.Draw({orgId: orgs[i], proof: CatalogTree.proof(leaves, i)});
        }
    }
}
