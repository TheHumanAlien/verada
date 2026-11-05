// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";

/// @title EpochGovernor
/// @notice Weekly epochs in which holders pick the cause that receives a token's cause pool.
/// @dev The governor owns eligibility, weights and ballot composition; the pluggable
///      `IVotingScheme` owns the ballots and the tally. An epoch is a poll keyed
///      `(this, token, epoch)` on the scheme it was opened with, so swapping the scheme only
///      affects epochs opened afterwards. Weights are the token's vote checkpoints at
///      `snapshotFor(token, epoch)` in whole tokens: `snapshotOf(epoch)`, except in the epoch a
///      token launches in, which predates the token and uses its launch snapshot instead.
///      Ballots come from the token's cause focus over `CauseCatalog`: the controller's pins plus
///      deterministic rotation draws (see `IEpochGovernor`). The catalogue version is the one in
///      effect at the epoch's start and pins change from the next epoch, so nobody can reshape a
///      running epoch's ballot. Ballots are accepted only once the epoch is opened, so a ballot's
///      option index always refers to the list frozen by an earlier transaction. Catalogue orgs
///      reach `CauseRegistry` storage only when one wins.
///      An epoch whose tally never arrives (scheme outage, governor delisted) finalizes to the
///      default cause once `TALLY_GRACE` has passed, so its cause pool cannot be stranded.
contract EpochGovernor is IEpochGovernor, IBallotGovernor, Ownable2Step {
    /// @inheritdoc IEpochGovernor
    uint256 public constant EPOCH_LENGTH = 7 days;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MAX_OPTIONS = 32;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MIN_OPTIONS = 2;

    /// @inheritdoc IEpochGovernor
    uint8 public constant PINNED_MAX = 8;

    /// @inheritdoc IEpochGovernor
    uint256 public constant DRAW_FACTOR = 3;

    /// @inheritdoc IEpochGovernor
    uint256 public constant TALLY_GRACE = 14 days;

    /// @inheritdoc IEpochGovernor
    uint256 public constant LAUNCH_SNAPSHOT_DELAY = 1 days;

    /// @inheritdoc IEpochGovernor
    uint256 public immutable epochZeroStart;

    /// @notice Cause registry: blocked causes are skipped, winners are materialized into it.
    ICauseRegistry public immutable registry;

    ICauseCatalog private immutable _catalog;

    /// @notice Profile registry naming the controller allowed to pin causes, and each token's focus.
    ITokenProfileRegistry public immutable profileRegistry;

    /// @notice Factory allowed to register tokens (set once by the owner).
    address public factory;

    /// @inheritdoc IEpochGovernor
    bytes32 public defaultCause;

    IVotingScheme private _scheme;

    /// @notice Curator agents' weekly picks (unset: no curated phase).
    ICuratorRegistry public curators;

    /// @dev Pinned catalogue org ids in effect (`current`) and an optional replacement (`next`)
    ///      taking effect from epoch `nextFrom` (zero: none scheduled). Views and events report
    ///      cause ids (`keccak256(orgId)`).
    struct Schedule {
        bytes32[] current;
        bytes32[] next;
        uint256 nextFrom;
    }

    /// @dev Outcome of reading an epoch's tally from its scheme.
    enum TallyStatus {
        Valid,
        NotFinal,
        Invalid
    }

    struct EpochState {
        bool prepared;
        bool opened;
        bool closed;
        bool finalized;
        bool closeFailed;
        IVotingScheme scheme;
        uint32 catalogVersion;
        bytes32 winner;
        uint256 voters;
        uint256 poolSize;
        /// @dev Catalogue org ids of the options, in ballot order.
        bytes32[] options;
        mapping(address voter => bool) voted;
    }

    mapping(address token => bool) public isRegistered;

    /// @inheritdoc IEpochGovernor
    mapping(address token => uint256) public launchSnapshotOf;

    mapping(address token => Schedule) private _shortlists;
    mapping(address token => mapping(uint256 epoch => EpochState)) private _epochs;
    mapping(address token => mapping(uint256 epoch => mapping(bytes32 causeId => uint256))) private
        _tally;

    /// @param initialOwner Admin allowed to set the factory once, swap the scheme and set the
    ///        fallback cause.
    /// @param registry_ Cause registry (this governor must be one of its materializers).
    /// @param catalog_ Cause catalogue.
    /// @param scheme_ Initial voting scheme.
    /// @param profileRegistry_ Token profile registry (pin authority and focus).
    constructor(
        address initialOwner,
        ICauseRegistry registry_,
        ICauseCatalog catalog_,
        IVotingScheme scheme_,
        ITokenProfileRegistry profileRegistry_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || address(catalog_) == address(0)
                || address(scheme_) == address(0) || address(profileRegistry_) == address(0)
        ) revert ZeroAddress();
        registry = registry_;
        _catalog = catalog_;
        _scheme = scheme_;
        profileRegistry = profileRegistry_;
        // Align epoch 0 to the Thursday 00:00 UTC at or before deployment (unix time 0 was a
        // Thursday), so the first epoch may be shorter than a full week.
        // forge-lint: disable-next-line(divide-before-multiply)
        epochZeroStart = (block.timestamp / EPOCH_LENGTH) * EPOCH_LENGTH;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the factory. Can only be done once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Replaces the voting scheme for epochs opened from now on. Epochs already opened
    ///         keep the scheme they were opened with.
    function setScheme(IVotingScheme scheme_) external onlyOwner {
        if (address(scheme_) == address(0)) revert ZeroAddress();
        _scheme = scheme_;
        emit SchemeUpdated(address(scheme_));
    }

    /// @notice Sets the fallback cause paid when an epoch ends with no ballots, so its funds are
    ///         never stranded. Zero clears the fallback; otherwise the cause must be active.
    function setDefaultCause(bytes32 causeId) external onlyOwner {
        if (causeId != bytes32(0) && !registry.isActive(causeId)) revert InactiveCause(causeId);
        defaultCause = causeId;
        emit DefaultCauseSet(causeId);
    }

    /// @inheritdoc IEpochGovernor
    function setShortlist(address token, Pin[] calldata pins) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
        (bytes32[] memory orgs, bytes32[] memory causes) = _validatePins(token, pins);
        // Until the current epoch's ballot is prepared the new pins may still apply to it.
        uint256 effectiveFrom =
            _schedule(_shortlists[token], orgs, !_epochs[token][currentEpoch()].prepared);
        emit ShortlistSet(token, causes);
        emit ShortlistScheduled(token, effectiveFrom, causes);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev A token registered in the epoch it was created in had no supply at that epoch's
    ///      snapshot, so nobody could vote in it. Such a token gets a launch snapshot inside the
    ///      epoch: `LAUNCH_SNAPSHOT_DELAY` after registration, or halfway to the epoch's end when
    ///      less than twice that remains, so holders who bought at launch can vote on the fees of
    ///      the launch epoch. Like every snapshot, it is fixed and public in advance.
    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        uint256 size = _catalog.poolSize(_catalog.latestVersion(), categoryMask, regionMask);
        if (size < MIN_OPTIONS) revert PoolTooSmall(token, size);
        isRegistered[token] = true;

        uint256 epoch = currentEpoch();
        if (launchSnapshotOf[token] != 0 || _hasSupplyAt(token, snapshotOf(epoch))) return;
        uint256 delay = (epochStart(epoch + 1) - block.timestamp) / 2;
        if (delay > LAUNCH_SNAPSHOT_DELAY) delay = LAUNCH_SNAPSHOT_DELAY;
        uint256 snapshot = block.timestamp + delay;
        launchSnapshotOf[token] = snapshot;
        emit LaunchSnapshotSet(token, epoch, snapshot);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @inheritdoc IEpochGovernor
    function prepareBallot(address token, uint256 epoch, Draw[] calldata draws) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, new CuratedDraw[](0), draws);
    }

    /// @inheritdoc IEpochGovernor
    function prepareCuratedBallot(
        address token,
        uint256 epoch,
        CuratedDraw[] calldata curated,
        Draw[] calldata draws
    ) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, curated, draws);
    }

    /// @inheritdoc IEpochGovernor
    function setCuratorRegistry(ICuratorRegistry curators_) external onlyOwner {
        if (address(curators) != address(0)) revert CuratorRegistryAlreadySet();
        if (address(curators_) == address(0)) revert ZeroAddress();
        curators = curators_;
        emit CuratorRegistrySet(address(curators_));
    }

    /// @inheritdoc IEpochGovernor
    function openEpoch(address token, uint256 epoch) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, new CuratedDraw[](0), new Draw[](0));
    }

    /// @inheritdoc IBallotGovernor
    /// @dev Called by the scheme while the voter's `castBallot` transaction executes. The epoch
    ///      must already be opened: a ballot's encrypted option index is only meaningful against
    ///      the frozen `epochOptions`, and a ballot that prepared the epoch itself would be counted
    ///      against whatever list was in effect when it was mined (the controller can change the
    ///      pins of an unprepared epoch, and blocks shift the remaining options).
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64 weight)
    {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (scope != currentEpoch()) revert EpochNotCurrent(scope);

        EpochState storage s = _epochs[token][scope];
        IVotingScheme expected = s.opened ? s.scheme : _scheme;
        if (msg.sender != address(expected)) revert NotScheme(msg.sender);
        if (!s.opened) {
            // A prepared ballot with fewer than MIN_OPTIONS options never opens.
            if (s.prepared) revert NoShortlist(token);
            revert EpochNotOpened(token, scope);
        }

        if (s.voted[voter]) revert AlreadyVoted(voter);
        weight = _weightAt(token, snapshotFor(token, scope), voter);
        if (weight == 0) revert InvalidVote();

        s.voted[voter] = true;
        unchecked {
            ++s.voters;
        }
        emit VoteCast(token, scope, ballotRef);
    }

    /// @inheritdoc IEpochGovernor
    function closeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);
        EpochState storage s = _epochs[token][epoch];
        if (!s.opened) revert EpochNotOpened(token, epoch);
        if (s.closed && !s.closeFailed) revert EpochAlreadyClosed(token, epoch);
        s.closed = true;
        uint256 gasBefore = gasleft();
        try s.scheme.requestTally(token, epoch) {
            s.closeFailed = false;
            emit EpochClosed(token, epoch);
        } catch {
            // A call starved of gas by the caller is not a scheme failure: revert so the epoch is
            // not marked failed on purpose. The callee gets at most 63/64 of the gas.
            if (gasleft() <= gasBefore / 64) revert InsufficientGas();
            s.closeFailed = true;
            emit EpochCloseFailed(token, epoch);
        }
    }

    /// @inheritdoc IEpochGovernor
    /// @dev With no ballots (or a tally that counted nothing) the owner-set `defaultCause` wins;
    ///      if none is set, or it is inactive, this reverts with `NoVotes` until one is. With
    ///      ballots but no valid final tally, this reverts until `TALLY_GRACE` after the epoch's
    ///      end and then falls back to `defaultCause` as well. A catalogue winner is materialized
    ///      into the registry. The winner is stored even if the cause was blocked after the
    ///      ballot was prepared; the distributor resolves its payout from the registry, which
    ///      keeps deactivated records.
    function finalizeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);

        EpochState storage s = _epochs[token][epoch];
        if (s.finalized) revert EpochAlreadyFinalized(token, epoch);

        bytes32 winner;
        bytes32 winnerOrg;
        uint256 best;
        bool timedOut;
        if (s.opened && s.voters != 0) {
            bytes32[] storage options = s.options;
            uint256 n = options.length;
            (TallyStatus status, uint64[] memory counts) = _finalCounts(s.scheme, token, epoch, n);
            if (status == TallyStatus.Valid) {
                for (uint256 i; i < n; ++i) {
                    bytes32 causeId = _causeIdOf(options[i]);
                    _tally[token][epoch][causeId] = counts[i];
                    // Strictly greater, so ties go to the lowest index.
                    if (counts[i] > best) {
                        best = counts[i];
                        winner = causeId;
                        winnerOrg = options[i];
                    }
                }
            } else {
                // forge-lint: disable-next-line(block-timestamp)
                if (block.timestamp < epochStart(epoch + 1) + TALLY_GRACE) {
                    if (status == TallyStatus.Invalid) revert InvalidTally(token, epoch);
                    revert TallyNotFinal(token, epoch);
                }
                timedOut = true;
            }
        }
        if (best != 0) {
            // A catalogue winner is written to the registry so the distributor can pay it.
            registry.materialize(winnerOrg);
        } else {
            winner = defaultCause;
            if (winner == bytes32(0) || !registry.isActive(winner)) revert NoVotes(token, epoch);
            if (timedOut) emit TallyTimeoutFallbackApplied(token, epoch, winner);
            else emit NoVoteFallbackApplied(token, epoch, winner);
        }

        s.finalized = true;
        s.winner = winner;
        emit EpochFinalized(token, epoch, winner);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IEpochGovernor
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - epochZeroStart) / EPOCH_LENGTH;
    }

    /// @inheritdoc IEpochGovernor
    function epochStart(uint256 epoch) public view returns (uint256) {
        return epochZeroStart + epoch * EPOCH_LENGTH;
    }

    /// @inheritdoc IEpochGovernor
    function snapshotOf(uint256 epoch) public view returns (uint256) {
        return epochStart(epoch) - 1;
    }

    /// @inheritdoc IEpochGovernor
    function snapshotFor(address token, uint256 epoch) public view returns (uint256) {
        uint256 launch = launchSnapshotOf[token];
        if (launch != 0 && epoch == (launch - epochZeroStart) / EPOCH_LENGTH) return launch;
        return snapshotOf(epoch);
    }

    /// @inheritdoc IEpochGovernor
    function scheme() external view returns (address) {
        return address(_scheme);
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        return _causeIds(_listAt(_shortlists[token], currentEpoch()));
    }

    /// @inheritdoc IEpochGovernor
    function shortlistFor(address token, uint256 epoch) external view returns (bytes32[] memory) {
        return _causeIds(_listAt(_shortlists[token], epoch));
    }

    /// @inheritdoc IEpochGovernor
    function pendingShortlistOf(address token)
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        (bytes32[] memory orgs, uint256 from) = _pending(_shortlists[token]);
        return (_causeIdsMem(orgs), from);
    }

    /// @inheritdoc IEpochGovernor
    function epochOptionOrgIds(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory)
    {
        return _epochs[token][epoch].options;
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOrgIdsFor(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory)
    {
        return _listAt(_shortlists[token], epoch);
    }

    /// @inheritdoc IEpochGovernor
    function poolOf(address token, uint256 epoch)
        external
        view
        returns (uint32 version, uint256 poolSize)
    {
        EpochState storage s = _epochs[token][epoch];
        if (s.prepared) return (s.catalogVersion, s.poolSize);
        version = _catalog.versionAt(epochStart(epoch));
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        poolSize = _catalog.poolSize(version, categoryMask, regionMask);
    }

    /// @inheritdoc IEpochGovernor
    function drawIndex(address token, uint256 epoch, uint32 version, uint256 k, uint256 poolSize)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(token, epoch, version, k))) % poolSize;
    }

    /// @inheritdoc IEpochGovernor
    function ballotSize() public view returns (uint256) {
        uint256 cap = _scheme.MAX_OPTIONS();
        return cap < MAX_OPTIONS ? cap : MAX_OPTIONS;
    }

    /// @inheritdoc IEpochGovernor
    function catalog() external view returns (address) {
        return address(_catalog);
    }

    /// @inheritdoc IEpochGovernor
    function isPrepared(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].prepared;
    }

    /// @inheritdoc IEpochGovernor
    function epochOptions(address token, uint256 epoch) external view returns (bytes32[] memory) {
        return _causeIds(_epochs[token][epoch].options);
    }

    /// @inheritdoc IEpochGovernor
    function epochScheme(address token, uint256 epoch) external view returns (address) {
        return address(_epochs[token][epoch].scheme);
    }

    /// @inheritdoc IEpochGovernor
    function isOpened(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].opened;
    }

    /// @inheritdoc IEpochGovernor
    function isClosed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closed;
    }

    /// @inheritdoc IEpochGovernor
    function closeFailed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closeFailed;
    }

    /// @inheritdoc IEpochGovernor
    function isFinalized(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].finalized;
    }

    /// @inheritdoc IEpochGovernor
    function winningCause(address token, uint256 epoch) external view returns (bytes32) {
        return _epochs[token][epoch].winner;
    }

    /// @inheritdoc IEpochGovernor
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256) {
        return _tally[token][epoch][causeId];
    }

    /// @inheritdoc IEpochGovernor
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool) {
        return _epochs[token][epoch].voted[voter];
    }

    /// @inheritdoc IEpochGovernor
    function voterCount(address token, uint256 epoch) external view returns (uint256) {
        return _epochs[token][epoch].voters;
    }

    /// @inheritdoc IEpochGovernor
    function weightOf(address token, uint256 epoch, address account)
        external
        view
        returns (uint64)
    {
        return _weightAt(token, snapshotFor(token, epoch), account);
    }

    // ------------------------------------------------------------------ internals

    function _checkPreparable(address token, uint256 epoch) private view {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch != currentEpoch()) revert EpochNotCurrent(epoch);
        EpochState storage s = _epochs[token][epoch];
        if (s.opened) revert EpochAlreadyOpened(token, epoch);
        if (s.prepared) revert BallotAlreadyPrepared(token, epoch);
    }

    /// @dev A ballot being built: cause ids (for repeats and events) and org ids (stored).
    struct Ballot {
        bytes32[] options;
        bytes32[] orgs;
        uint256 n;
        uint256 size;
    }

    /// @dev Fixes the epoch's ballot (pins, then curated picks, then rotation draws) and opens its
    ///      poll when it has at least `MIN_OPTIONS` options.
    function _prepare(
        address token,
        uint256 epoch,
        CuratedDraw[] memory curated,
        Draw[] memory draws
    ) private {
        EpochState storage s = _epochs[token][epoch];
        uint32 version = _catalog.versionAt(epochStart(epoch));
        Ballot memory b;
        b.size = ballotSize();
        b.options = new bytes32[](b.size);
        b.orgs = new bytes32[](b.size);

        bytes32[] storage pins = _listAt(_shortlists[token], epoch);
        for (uint256 i; i < pins.length && b.n < b.size; ++i) {
            bytes32 causeId = _causeIdOf(pins[i]);
            if (registry.isBlocked(causeId)) continue;
            b.orgs[b.n] = pins[i];
            b.options[b.n++] = causeId;
        }
        // Pins are capped at PINNED_MAX, which fits a uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 pinned = uint8(b.n);

        uint256 pool;
        uint256 used;
        uint256 curatedUsed;
        if (version != 0) {
            (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
            (uint16[] memory buckets, uint32[] memory sizes) =
                _catalog.focusBuckets(version, categoryMask, regionMask);
            for (uint256 i; i < sizes.length; ++i) {
                pool += sizes[i];
            }
            if (address(curators) != address(0) && b.n < b.size && buckets.length != 0) {
                curatedUsed = _curate(token, epoch, version, buckets, sizes, curated, b);
            }
            if (pool != 0 && b.n < b.size) {
                used = _draw(token, epoch, version, pool, buckets, sizes, draws, b);
            }
        }
        if (curated.length != curatedUsed) revert TooManyCuratedDraws(curated.length, curatedUsed);
        if (draws.length != used) revert TooManyDraws(draws.length, used);

        bytes32[] memory options = b.options;
        bytes32[] memory orgs = b.orgs;
        uint256 n = b.n;
        assembly ("memory-safe") {
            mstore(options, n)
            mstore(orgs, n)
        }
        s.prepared = true;
        s.catalogVersion = version;
        s.poolSize = pool;
        s.options = orgs;
        emit BallotPrepared(token, epoch, version, pool, pinned, options);

        if (n >= MIN_OPTIONS) {
            s.opened = true;
            s.scheme = _scheme;
            // Ballots are capped at MAX_OPTIONS, which fits a uint8.
            // forge-lint: disable-next-line(unsafe-typecast)
            _scheme.open(token, epoch, uint8(n));
            emit EpochOpened(token, epoch, options);
        }
    }

    /// @dev Curated phase: splits the free slots across the focus buckets' curations by weight
    ///      (`curatedQuotas`), then takes ranks `0..quota-1` of each bucket in bucket order. A pick
    ///      whose catalogue entry is another org, or whose index is past the bucket, is skipped.
    ///      Returns the number of curated draws consumed.
    function _curate(
        address token,
        uint256 epoch,
        uint32 version,
        uint16[] memory buckets,
        uint32[] memory sizes,
        CuratedDraw[] memory curated,
        Ballot memory b
    ) private returns (uint256 k) {
        ICuratorRegistry.Curation[] memory cs = curators.curationsFor(epoch, version, buckets);
        uint256[] memory quotas = _quotas(b.size - b.n, cs);
        bytes32 root = _catalog.rootOf(version);
        uint256 included;
        for (uint256 i; i < cs.length; ++i) {
            for (uint256 rank; rank < quotas[i]; ++rank) {
                if (k >= curated.length) revert IncompleteCuratedBallot(token, epoch, k);
                CuratedDraw memory d = curated[k];
                if (!MerkleProof.verify(
                        d.pickProof, cs[i].picksRoot, _pickLeaf(rank, d.catalogIndex, d.pickOrgId)
                    )) {
                    revert InvalidCuratedDraw(k);
                }
                ++k;
                if (d.catalogIndex >= sizes[i]) continue;
                if (!MerkleProof.verify(
                        d.entryProof, root, _leaf(buckets[i], d.catalogIndex, d.entryOrgId)
                    )) {
                    revert InvalidCuratedDraw(k - 1);
                }
                if (d.entryOrgId != d.pickOrgId) continue;
                bytes32 causeId = _causeIdOf(d.pickOrgId);
                if (
                    b.n >= b.size || registry.isBlocked(causeId)
                        || _contains(b.options, b.n, causeId)
                ) {
                    continue;
                }
                b.orgs[b.n] = d.pickOrgId;
                b.options[b.n++] = causeId;
                ++included;
            }
        }
        // Both are bounded by the ballot size (at most 32).
        // forge-lint: disable-next-line(unsafe-typecast)
        if (k != 0) emit CuratedPicksUsed(token, epoch, uint8(k), uint8(included));
    }

    /// @dev Slots per curation: `min(count, slots * weight / totalWeight)`, then leftovers one at a
    ///      time to buckets below their count, in order, round after round. Mirrors the SDK's
    ///      `curatedQuotas`.
    function _quotas(uint256 slots, ICuratorRegistry.Curation[] memory cs)
        private
        pure
        returns (uint256[] memory q)
    {
        q = new uint256[](cs.length);
        uint256 total;
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].count != 0) total += cs[i].weight;
        }
        if (slots == 0 || total == 0) return q;
        uint256 assigned;
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].count == 0 || cs[i].weight == 0) continue;
            uint256 share = (slots * cs[i].weight) / total;
            q[i] = share < cs[i].count ? share : cs[i].count;
            assigned += q[i];
        }
        uint256 rest = slots - assigned;
        while (rest != 0) {
            bool progressed;
            for (uint256 i; i < cs.length && rest != 0; ++i) {
                if (cs[i].weight != 0 && q[i] < cs[i].count) {
                    ++q[i];
                    --rest;
                    progressed = true;
                }
            }
            if (!progressed) break;
        }
    }

    /// @dev Rotation: consumes draws until the ballot is full or the draw budget is spent. With a
    ///      pool no larger than the free slots, walks the whole pool in order instead.
    function _draw(
        address token,
        uint256 epoch,
        uint32 version,
        uint256 pool,
        uint16[] memory buckets,
        uint32[] memory sizes,
        Draw[] memory draws,
        Ballot memory b
    ) private view returns (uint256 k) {
        bytes32 root = _catalog.rootOf(version);
        uint256 slots = b.size - b.n;
        bool sequential = pool <= slots;
        uint256 budget = sequential ? pool : DRAW_FACTOR * slots;
        for (; k < budget && b.n < b.size; ++k) {
            if (k >= draws.length) revert IncompleteBallot(token, epoch, k);
            uint256 idx = sequential ? k : drawIndex(token, epoch, version, k, pool);
            (uint16 bucket, uint32 index) = _locate(buckets, sizes, idx);
            bytes32 orgId = draws[k].orgId;
            if (!MerkleProof.verify(draws[k].proof, root, _leaf(bucket, index, orgId))) {
                revert InvalidDraw(k);
            }
            bytes32 causeId = _causeIdOf(orgId);
            if (registry.isBlocked(causeId) || _contains(b.options, b.n, causeId)) continue;
            b.orgs[b.n] = orgId;
            b.options[b.n++] = causeId;
        }
    }

    /// @dev Distinct, unblocked catalogue entries inside the token's focus, at most PINNED_MAX.
    ///      Returns their org ids and cause ids.
    function _validatePins(address token, Pin[] calldata pins)
        private
        view
        returns (bytes32[] memory orgs, bytes32[] memory causes)
    {
        uint256 n = pins.length;
        if (n > PINNED_MAX) revert InvalidShortlist();
        orgs = new bytes32[](n);
        causes = new bytes32[](n);
        if (n == 0) return (orgs, causes);
        uint32 version = _catalog.latestVersion();
        if (version == 0) revert NotInCatalog(pins[0].orgId);
        bytes32 root = _catalog.rootOf(version);
        uint32[] memory sizes = _catalog.bucketSizesOf(version);
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        for (uint256 i; i < n; ++i) {
            Pin calldata p = pins[i];
            if (!_catalog.inFocus(p.bucket, categoryMask, regionMask)) {
                revert OutOfFocus(p.orgId, p.bucket);
            }
            if (
                p.bucket >= sizes.length || p.index >= sizes[p.bucket]
                    || !MerkleProof.verifyCalldata(p.proof, root, _leaf(p.bucket, p.index, p.orgId))
            ) revert NotInCatalog(p.orgId);
            bytes32 causeId = _causeIdOf(p.orgId);
            if (registry.isBlocked(causeId)) revert InactiveCause(causeId);
            if (_contains(causes, i, causeId)) revert InvalidShortlist();
            causes[i] = causeId;
            orgs[i] = p.orgId;
        }
    }

    function _locate(uint16[] memory buckets, uint32[] memory sizes, uint256 poolIndex)
        private
        pure
        returns (uint16, uint32)
    {
        uint256 rest = poolIndex;
        uint256 i;
        while (rest >= sizes[i]) {
            rest -= sizes[i];
            ++i;
        }
        // `rest < sizes[i]`, a uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (buckets[i], uint32(rest));
    }

    function _pickLeaf(uint256 rank, uint32 catalogIndex, bytes32 orgId)
        private
        pure
        returns (bytes32)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        return keccak256(bytes.concat(keccak256(abi.encode(uint8(rank), catalogIndex, orgId))));
    }

    function _leaf(uint16 bucket, uint32 index, bytes32 orgId) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(bucket, index, orgId))));
    }

    function _causeIdOf(bytes32 orgId) private pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    function _causeIds(bytes32[] storage orgs) private view returns (bytes32[] memory out) {
        out = new bytes32[](orgs.length);
        for (uint256 i; i < out.length; ++i) {
            out[i] = _causeIdOf(orgs[i]);
        }
    }

    function _causeIdsMem(bytes32[] memory orgs) private pure returns (bytes32[] memory out) {
        out = new bytes32[](orgs.length);
        for (uint256 i; i < out.length; ++i) {
            out[i] = _causeIdOf(orgs[i]);
        }
    }

    function _contains(bytes32[] memory list, uint256 n, bytes32 x) private pure returns (bool) {
        for (uint256 i; i < n; ++i) {
            if (list[i] == x) return true;
        }
        return false;
    }

    /// @dev Whole-token vote checkpoint of `account` at `snapshot`, capped to 64 bits; zero while
    ///      the snapshot is not yet in the past.
    function _weightAt(address token, uint256 snapshot, address account)
        private
        view
        returns (uint64)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) return 0;
        uint256 whole = IVotes(token).getPastVotes(account, snapshot) / 1e18;
        // Capped just above, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
    }

    /// @dev Whether `token` reports a non-zero total supply at `timepoint`. A token that cannot
    ///      answer is treated as having one, so it keeps the regular epoch snapshot.
    function _hasSupplyAt(address token, uint256 timepoint) private view returns (bool) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IVotes.getPastTotalSupply, (timepoint)));
        if (!ok || ret.length < 32) return true;
        return abi.decode(ret, (uint256)) != 0;
    }

    /// @dev Final per-option counts of the epoch's poll. A reverting scheme reads as not final.
    function _finalCounts(IVotingScheme scheme_, address token, uint256 epoch, uint256 n)
        private
        view
        returns (TallyStatus status, uint64[] memory counts)
    {
        try scheme_.tallyOf(address(this), token, epoch) returns (bool isFinal, uint64[] memory c) {
            if (!isFinal) return (TallyStatus.NotFinal, c);
            if (c.length != n) return (TallyStatus.Invalid, c);
            return (TallyStatus.Valid, c);
        } catch {
            return (TallyStatus.NotFinal, counts);
        }
    }

    /// @dev List of `s` in effect for `epoch` (exact for epochs at or after the one in which the
    ///      schedule last changed, which covers the current and later epochs).
    function _listAt(Schedule storage s, uint256 epoch) private view returns (bytes32[] storage) {
        uint256 from = s.nextFrom;
        return from != 0 && epoch >= from ? s.next : s.current;
    }

    function _pending(Schedule storage s)
        private
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        uint256 from = s.nextFrom;
        if (from == 0 || currentEpoch() >= from) return (causes, 0);
        return (s.next, from);
    }

    /// @dev Replaces the list of `s` from the next epoch, or from the current one when
    ///      `immediate`. Returns the epoch from which `causes` apply.
    function _schedule(Schedule storage s, bytes32[] memory causes, bool immediate)
        private
        returns (uint256 effectiveFrom)
    {
        uint256 current = currentEpoch();
        uint256 from = s.nextFrom;
        if (from != 0 && current >= from) s.current = s.next;
        if (immediate) {
            s.current = causes;
            delete s.next;
            delete s.nextFrom;
            return current;
        }
        s.next = causes;
        s.nextFrom = current + 1;
        return current + 1;
    }
}
