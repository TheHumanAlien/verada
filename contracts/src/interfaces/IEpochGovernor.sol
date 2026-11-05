// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICuratorRegistry} from "./ICuratorRegistry.sol";

/// @title IEpochGovernor
/// @notice Weekly epochs in which token holders choose the cause receiving the cause pool.
/// @dev Each epoch of a token is a poll on the pluggable voting scheme. Its ballot is prepared at
///      the start of the epoch from the token's cause focus (fixed at launch) and the cause
///      catalogue version in effect at that time:
///      - up to `PINNED_MAX` causes pinned by the token's controller (its "shortlist"), each proven
///        to be a catalogue entry inside the focus; pins take effect from the next epoch;
///      - the rest filled by rotation: draw `k` is pool entry
///        `keccak256(abi.encode(token, epoch, version, k)) % poolSize`, skipping blocked causes and
///        repeats, so over time every charity in the focus reaches a ballot. When the pool is not
///        larger than the free slots, the whole pool is taken in order.
///      Anyone may prepare a ballot by supplying the entries and Merkle proofs for exactly those
///      draws (`prepareBallot`); the filler has no choice in what is drawn.
///      Voters do not call the governor: they call
///      `IVotingScheme.castBallot(address(governor), token, epoch, ballot)` on the scheme the epoch
///      was opened with, which calls back `authorizeBallot` so the governor can check eligibility
///      and return the voter's weight. Ballots are accepted only once the epoch is opened (by
///      `prepareBallot` or `openEpoch`), and their option index refers to `epochOptions`. Weight is
///      the voter's vote checkpoint at `snapshotFor(token, epoch)`, in whole tokens:
///      `snapshotOf(epoch)` (the second before the epoch starts), except in the epoch a token
///      launches in, which predates the token and uses its `launchSnapshotOf` instead. The voter and
///      weight are public; the choice is as private as the scheme makes it.
interface IEpochGovernor {
    /// @notice A pinned cause: catalogue entry `(bucket, index, orgId)` and its Merkle proof
    ///         against the latest catalogue version.
    struct Pin {
        bytes32 orgId;
        uint16 bucket;
        uint32 index;
        bytes32[] proof;
    }

    /// @notice The catalogue entry at a rotation draw's pool index, with its Merkle proof. The
    ///         bucket and index are derived by the governor.
    struct Draw {
        bytes32 orgId;
        bytes32[] proof;
    }

    /// @notice A curated pick (bucket and rank derived by the governor): the pick leaf
    ///         `(rank, catalogIndex, pickOrgId)` with its proof against the agent's picks root, and
    ///         the catalogue entry actually at `(bucket, catalogIndex)` with its catalogue proof
    ///         (ignored when the index is past the bucket). The pick counts only when both orgs match.
    struct CuratedDraw {
        uint32 catalogIndex;
        bytes32 pickOrgId;
        bytes32[] pickProof;
        bytes32 entryOrgId;
        bytes32[] entryProof;
    }

    /// @notice Emitted when a vote is cast. `voteRef` is opaque so private schemes can replace it.
    event VoteCast(address indexed token, uint256 indexed epoch, bytes32 voteRef);

    /// @notice Emitted when an epoch is finalized with its winning cause.
    event EpochFinalized(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Emitted when an epoch's poll is opened with its frozen options.
    event EpochOpened(address indexed token, uint256 indexed epoch, bytes32[] options);

    /// @notice Emitted when a token registered in the epoch it was created in gets a launch
    ///         snapshot, at which the weights of that epoch are read.
    event LaunchSnapshotSet(address indexed token, uint256 indexed epoch, uint256 snapshot);

    /// @notice Emitted when an epoch's poll is closed and the tally requested.
    event EpochClosed(address indexed token, uint256 indexed epoch);

    /// @notice Emitted when an epoch with no ballots falls back to the default cause.
    event NoVoteFallbackApplied(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Emitted when an epoch with ballots falls back to the default cause because no
    ///         valid final tally arrived within `TALLY_GRACE` after the epoch ended.
    event TallyTimeoutFallbackApplied(
        address indexed token, uint256 indexed epoch, bytes32 causeId
    );

    /// @notice Emitted when closing an epoch could not request the tally from its scheme (for
    ///         example because the scheme no longer lists this governor). `closeEpoch` may be
    ///         retried; otherwise the epoch falls back to the default cause after `TALLY_GRACE`.
    event EpochCloseFailed(address indexed token, uint256 indexed epoch);

    /// @notice Emitted with every token shortlist change: the epoch from which `causes` apply.
    event ShortlistScheduled(
        address indexed token, uint256 indexed effectiveFrom, bytes32[] causes
    );

    /// @notice Emitted when an epoch's ballot is fixed. `pinned` options come first, then the
    ///         rotation draws. With fewer than `MIN_OPTIONS` options the epoch is not opened and
    ///         finalizes to the default cause.
    event BallotPrepared(
        address indexed token,
        uint256 indexed epoch,
        uint32 catalogVersion,
        uint256 poolSize,
        uint8 pinned,
        bytes32[] options
    );

    event SchemeUpdated(address indexed scheme);
    event CuratorRegistrySet(address curators);
    /// @notice Curated phase of a ballot: `drawn` picks checked, `included` of them on the ballot.
    event CuratedPicksUsed(
        address indexed token, uint256 indexed epoch, uint8 drawn, uint8 included
    );
    event FactorySet(address indexed factory);
    event DefaultCauseSet(bytes32 indexed causeId);
    event ShortlistSet(address indexed token, bytes32[] causes);

    error NotFactory();
    error NotScheme(address caller);
    error NotController(address token, address caller);
    error TokenNotRegistered(address token);
    error EpochNotEnded(uint256 epoch);
    error EpochNotCurrent(uint256 epoch);
    error EpochNotOpened(address token, uint256 epoch);
    error EpochAlreadyOpened(address token, uint256 epoch);
    error EpochAlreadyClosed(address token, uint256 epoch);
    error EpochAlreadyFinalized(address token, uint256 epoch);
    error TallyNotFinal(address token, uint256 epoch);
    error InvalidTally(address token, uint256 epoch);
    error InactiveCause(bytes32 causeId);
    error InvalidShortlist();
    error NoShortlist(address token);
    error NotInCatalog(bytes32 orgId);
    error OutOfFocus(bytes32 orgId, uint16 bucket);
    error BallotAlreadyPrepared(address token, uint256 epoch);
    /// @notice The ballot needs more draws than were supplied; `needed` is the next draw index.
    error IncompleteBallot(address token, uint256 epoch, uint256 needed);
    error TooManyDraws(uint256 supplied, uint256 used);
    error InvalidDraw(uint256 k);
    error PoolTooSmall(address token, uint256 poolSize);
    error IncompleteCuratedBallot(address token, uint256 epoch, uint256 needed);
    error TooManyCuratedDraws(uint256 supplied, uint256 used);
    error InvalidCuratedDraw(uint256 k);
    error CuratorRegistryAlreadySet();
    error InvalidVote();
    error AlreadyVoted(address voter);
    error NoVotes(address token, uint256 epoch);
    error ZeroAddress();
    error FactoryAlreadySet();
    error InsufficientGas();

    // ------------------------------------------------------------------ constants / config

    /// @notice Length of an epoch in seconds.
    function EPOCH_LENGTH() external view returns (uint256);

    /// @notice Largest ballot (further capped by the current scheme's `MAX_OPTIONS`).
    function MAX_OPTIONS() external view returns (uint8);

    /// @notice Smallest ballot that opens a poll; also the smallest focus pool a token may launch
    ///         with.
    function MIN_OPTIONS() external view returns (uint8);

    /// @notice Largest number of causes a controller may pin.
    function PINNED_MAX() external view returns (uint8);

    /// @notice Rotation gives up after `DRAW_FACTOR` draws per free slot (repeats are skipped).
    function DRAW_FACTOR() external view returns (uint256);

    /// @notice Ballot size for epochs prepared now: `min(MAX_OPTIONS, scheme.MAX_OPTIONS())`.
    function ballotSize() external view returns (uint256);

    /// @notice Cause catalogue that ballots draw from.
    function catalog() external view returns (address);

    /// @notice Seconds after an epoch ends during which its final tally may still arrive; past
    ///         it, an epoch without a valid final tally finalizes to the default cause.
    function TALLY_GRACE() external view returns (uint256);

    /// @notice Longest wait after a token's registration before its launch snapshot (shorter when
    ///         the launch epoch ends sooner: then halfway to its end).
    function LAUNCH_SNAPSHOT_DELAY() external view returns (uint256);

    /// @notice Timestamp at which epoch 0 starts.
    function epochZeroStart() external view returns (uint256);

    /// @notice Index of the current epoch.
    function currentEpoch() external view returns (uint256);

    /// @notice Start timestamp of `epoch`.
    function epochStart(uint256 epoch) external view returns (uint256);

    /// @notice Timestamp at which voting weights for `epoch` are read (the second before it starts).
    function snapshotOf(uint256 epoch) external view returns (uint256);

    /// @notice Timestamp at which `token`'s voting weights for `epoch` are read: `snapshotOf(epoch)`,
    ///         or the token's launch snapshot in the epoch it launched in.
    function snapshotFor(address token, uint256 epoch) external view returns (uint256);

    /// @notice Launch snapshot of a token created in the epoch it was registered in (zero when the
    ///         token had supply at that epoch's snapshot and uses the regular one).
    function launchSnapshotOf(address token) external view returns (uint256);

    /// @notice Voting scheme used for epochs opened from now on.
    function scheme() external view returns (address);

    /// @notice Cause that wins an epoch in which nobody voted (zero means no fallback).
    function defaultCause() external view returns (bytes32);

    /// @notice The token's pinned causes in effect for the current epoch.
    function shortlistOf(address token) external view returns (bytes32[] memory);
    /// @notice Pinned causes in effect for `epoch`. Exact for the current and later epochs; for a
    ///         prepared epoch `epochOptions` is authoritative.
    function shortlistFor(address token, uint256 epoch) external view returns (bytes32[] memory);
    /// @notice The token's pinned causes scheduled for a later epoch, and that epoch (zero when
    ///         nothing is scheduled). An empty list with a non-zero epoch schedules removing all pins.
    function pendingShortlistOf(address token)
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom);
    /// @notice Catalogue org ids of an epoch's options (`epochOptions` are their cause ids,
    ///      `keccak256(orgId)`).
    function epochOptionOrgIds(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory);
    /// @notice Catalogue org ids of the pins in effect for `epoch`.
    function shortlistOrgIdsFor(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory);
    /// @notice Catalogue version and focus pool size an epoch's ballot draws from (the version in
    ///         effect at the epoch's start).
    function poolOf(address token, uint256 epoch)
        external
        view
        returns (uint32 version, uint256 poolSize);
    /// @notice Pool index of rotation draw `k` (see the contract notes).
    function drawIndex(address token, uint256 epoch, uint32 version, uint256 k, uint256 poolSize)
        external
        pure
        returns (uint256);

    // ------------------------------------------------------------------ admin

    /// @notice Registers a token for voting. Callable by the factory only, after the token's focus
    ///         is set; reverts `PoolTooSmall` unless the latest catalogue gives its focus at least
    ///         `MIN_OPTIONS` entries.
    function registerToken(address token) external;

    /// @notice Sets a token's pinned causes (0..PINNED_MAX distinct, unblocked catalogue entries
    ///         inside its focus) from the next epoch, or from the current one if its ballot is not
    ///         prepared yet. Callable by the token's profile controller only.
    function setShortlist(address token, Pin[] calldata pins) external;

    // ------------------------------------------------------------------ lifecycle

    /// @notice Prepares and opens the current epoch's ballot for `token` (see the contract
    ///         notes). Permissionless. `draws` must be exactly the entries the rotation consumes.
    function prepareBallot(address token, uint256 epoch, Draw[] calldata draws) external;
    /// @notice `prepareBallot` with curated draws: the picks the curated phase consumes, in order,
    ///         then the rotation draws. Needed whenever curator agents published picks for the
    ///         token's focus buckets; `prepareBallot` (no curated draws) then reverts
    ///         `IncompleteCuratedBallot`.
    function prepareCuratedBallot(
        address token,
        uint256 epoch,
        CuratedDraw[] calldata curated,
        Draw[] calldata draws
    ) external;
    /// @notice Sets the curator registry. Owner only, once.
    function setCuratorRegistry(ICuratorRegistry curators_) external;
    /// @notice `prepareBallot` with no draws: works when the ballot needs none (empty pool, or
    ///         pins fill it). Permissionless. Ballots are rejected until the epoch is opened.
    function openEpoch(address token, uint256 epoch) external;

    /// @notice Closes an ended epoch's poll and asks the scheme for the tally. Permissionless. If
    ///         the scheme rejects the request the epoch is still marked closed (`EpochCloseFailed`)
    ///         and the call may be retried.
    function closeEpoch(address token, uint256 epoch) external;

    /// @notice Stores the winning cause of an ended epoch from the scheme's final tally, or the
    ///         default cause when nobody voted or when no valid final tally arrived within
    ///         `TALLY_GRACE` of the epoch's end. Permissionless.
    function finalizeEpoch(address token, uint256 epoch) external;

    // ------------------------------------------------------------------ epoch views

    /// @notice Whether the epoch's ballot has been prepared.
    function isPrepared(address token, uint256 epoch) external view returns (bool);
    /// @notice Options frozen for `(token, epoch)` (empty if not prepared).
    function epochOptions(address token, uint256 epoch) external view returns (bytes32[] memory);

    /// @notice Scheme the epoch was opened with (zero if not opened).
    function epochScheme(address token, uint256 epoch) external view returns (address);

    function isOpened(address token, uint256 epoch) external view returns (bool);
    function isClosed(address token, uint256 epoch) external view returns (bool);

    /// @notice Whether the last `closeEpoch` attempt failed to request the tally.
    function closeFailed(address token, uint256 epoch) external view returns (bool);

    /// @notice Whether the epoch has been finalized.
    function isFinalized(address token, uint256 epoch) external view returns (bool);

    /// @notice Winning cause of a finalized epoch (zero if not finalized).
    function winningCause(address token, uint256 epoch) external view returns (bytes32);

    /// @notice Final weight counted for a cause in a finalized epoch (zero when the cause was not on
    ///         the ballot or the epoch fell back to the default cause).
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256);

    /// @notice Whether `voter` cast a ballot in the epoch.
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool);

    /// @notice Number of ballots authorized in the epoch.
    function voterCount(address token, uint256 epoch) external view returns (uint256);

    /// @notice Voting weight of `account` in `epoch`, in whole tokens at `snapshotFor(token, epoch)`
    ///         (zero while the snapshot is still in the future).
    function weightOf(address token, uint256 epoch, address account) external view returns (uint64);
}
