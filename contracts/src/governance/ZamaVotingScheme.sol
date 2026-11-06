// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, ebool, euint128, euint8, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IBallotGovernor, IVotingScheme} from "../interfaces/IVotingScheme.sol";

/// @title ZamaVotingScheme
/// @notice `IVotingScheme` whose ballots are Zama FHEVM ciphertexts. A voter submits an encrypted
///         option index (`euint8`) with its input proof; the scheme adds the voter's weight to the
///         encrypted tally of the chosen option without learning which one, so no party learns an
///         individual choice. When the governor closes the poll the tallies are made publicly
///         decryptable; anyone then relays the KMS-signed cleartexts to `submitTally`.
/// @dev Packed tallies: each `euint128` word holds `COUNTERS_PER_WORD` counters of
///      `COUNTER_BITS` bits, option `i` living in word `i / 3` at bit `40 * (i % 3)`. A ballot
///      computes the weight shifted into its slot once and then, per word, adds it under an
///      encrypted equality test on the word index: three operations per word instead of three per
///      option, which is what makes 32-option ballots affordable. A counter must never exceed
///      `2^40 - 1` (1.1e12 whole tokens); Verada tokens have a fixed supply of 1e11 whole tokens,
///      so the sum of all weights in a poll cannot reach it.
///      Polls are keyed by `(governor, token, scope)`. Only allowlisted governors may open polls
///      and request tallies. The voter calls `castBallot` directly so that the input proof, which
///      the coprocessor binds to `msg.sender`, is checked against the voter; the governor is
///      consulted through `IBallotGovernor.authorizeBallot` and may open the poll lazily during
///      that call. Weights are whole tokens.
///      Lazy tallies: `open` only records the option count. The encrypted tally words are created
///      by the first ballot, which writes its own contribution into every word instead of adding
///      it to an encrypted zero, so a poll nobody votes in never touches the coprocessor. A poll
///      closed without ballots is final at once with all-zero counts (`TallySubmitted` is emitted
///      in `requestTally`), so it needs no public decryption either.
contract ZamaVotingScheme is IVotingScheme, Ownable2Step {
    /// @inheritdoc IVotingScheme
    uint8 public constant MAX_OPTIONS = 32;

    /// @notice Width of one packed counter.
    uint8 public constant COUNTER_BITS = 40;

    /// @notice Counters per `euint128` tally word.
    uint8 public constant COUNTERS_PER_WORD = 3;

    /// @notice Largest weight a single ballot may carry.
    uint64 public constant MAX_WEIGHT = uint64((1 << 40) - 1);

    uint256 private constant COUNTER_MASK = (1 << 40) - 1;
    uint256 private constant MAX_WORD = (1 << 120) - 1;

    error WeightTooLarge(uint64 weight);

    struct Poll {
        uint8 optionCount;
        bool opened;
        bool closed;
        bool isFinal;
        uint256 ballotCount;
        /// @dev Packed tally words (`ceil(optionCount / 3)`), created by the first ballot. Empty
        ///      while `ballotCount == 0`.
        euint128[] tallies;
        /// @dev Stored only by `submitTally`; a poll final without ballots keeps it empty and
        ///      `tallyOf` reports `optionCount` zeros.
        uint64[] counts;
        mapping(address voter => bool) voted;
    }

    /// @inheritdoc IVotingScheme
    mapping(address governor => bool) public isGovernor;

    mapping(address governor => mapping(address token => mapping(uint256 scope => Poll))) private
        _polls;

    /// @param initialOwner Account allowed to manage the governor allowlist.
    /// @dev Routes to the Zama coprocessor deployment of the current chain (Ethereum mainnet,
    ///      or the local chain id 31337 in tests); reverts `ZamaProtocolUnsupported` elsewhere.
    constructor(address initialOwner) Ownable(initialOwner) {
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
    }

    // ---- owner

    /// @notice Allows or disallows `governor` to open polls and request tallies.
    function setGovernor(address governor, bool allowed) external onlyOwner {
        isGovernor[governor] = allowed;
        emit GovernorSet(governor, allowed);
    }

    // ---- governor

    /// @inheritdoc IVotingScheme
    /// @dev Records the poll only; the tally words are created by the first ballot.
    function open(address token, uint256 scope, uint8 optionCount) external {
        if (!isGovernor[msg.sender]) revert NotGovernor(msg.sender);
        Poll storage poll = _polls[msg.sender][token][scope];
        if (poll.opened) revert PollAlreadyOpen(msg.sender, token, scope);
        if (optionCount < 2 || optionCount > MAX_OPTIONS) revert InvalidOptionCount(optionCount);

        poll.opened = true;
        poll.optionCount = optionCount;
        emit PollOpened(msg.sender, token, scope, optionCount);
    }

    /// @inheritdoc IVotingScheme
    /// @dev Without ballots there is nothing to decrypt: the poll becomes final with all-zero
    ///      counts here and `submitTally` is never needed.
    function requestTally(address token, uint256 scope) external {
        if (!isGovernor[msg.sender]) revert NotGovernor(msg.sender);
        Poll storage poll = _polls[msg.sender][token][scope];
        if (!poll.opened) revert PollNotOpen(msg.sender, token, scope);
        if (poll.closed) revert PollClosed(msg.sender, token, scope);

        poll.closed = true;
        uint256 words = poll.tallies.length;
        for (uint256 i = 0; i < words; ++i) {
            FHE.makePubliclyDecryptable(poll.tallies[i]);
        }
        emit TallyRequested(msg.sender, token, scope);
        if (words == 0) {
            poll.isFinal = true;
            emit TallySubmitted(msg.sender, token, scope, new uint64[](poll.optionCount));
        }
    }

    // ---- voter

    /// @inheritdoc IVotingScheme
    /// @dev `ballot` is `abi.encode(bytes32 handle, bytes inputProof)` where `handle` is the
    ///      external `euint8` option index produced by the relayer SDK for this voter and this
    ///      contract. An out-of-range option adds nothing to any counted option.
    function castBallot(address governor, address token, uint256 scope, bytes calldata ballot)
        external
        returns (bytes32 ballotRef)
    {
        if (!isGovernor[governor]) revert NotGovernor(governor);
        (bytes32 handleRaw, bytes memory inputProof) = _decodeBallot(ballot);
        ballotRef = keccak256(abi.encode(governor, token, scope, msg.sender, handleRaw));

        // The governor authorizes the voter and returns their weight. It may re-enter `open` here
        // to open the poll lazily, so the poll state is only read after this call.
        uint64 weight =
            IBallotGovernor(governor).authorizeBallot(token, scope, msg.sender, ballotRef);

        Poll storage poll = _polls[governor][token][scope];
        if (!poll.opened) revert PollNotOpen(governor, token, scope);
        if (poll.closed) revert PollClosed(governor, token, scope);
        if (weight == 0) revert ZeroWeight();
        if (weight > MAX_WEIGHT) revert WeightTooLarge(weight);
        if (poll.voted[msg.sender]) revert AlreadyVoted(msg.sender);

        poll.voted[msg.sender] = true;
        ++poll.ballotCount;

        // Binds the proof to msg.sender (the voter) and yields the encrypted option index.
        euint8 choice = FHE.fromExternal(externalEuint8.wrap(handleRaw), inputProof);
        _accumulate(poll, choice, weight);
        emit BallotCast(governor, token, scope, msg.sender, weight, ballotRef);
    }

    // ---- keeper (permissionless)

    /// @inheritdoc IVotingScheme
    /// @dev `cleartexts` is the ABI encoding of the decrypted tallies in option order, one 32-byte
    ///      word each, exactly as returned by the relayer SDK `publicDecrypt(tallyHandles)`
    ///      together with `proof` (the KMS decryption proof). Reverts `InvalidKMSSignatures`
    ///      (from the FHE library) when the KMS verifier rejects the proof.
    function submitTally(
        address governor,
        address token,
        uint256 scope,
        bytes calldata cleartexts,
        bytes calldata proof
    ) external {
        Poll storage poll = _polls[governor][token][scope];
        if (!poll.closed) revert PollNotClosed(governor, token, scope);
        if (poll.isFinal) revert TallyAlreadyFinal(governor, token, scope);
        uint256 n = poll.optionCount;
        uint256 words = poll.tallies.length;
        if (cleartexts.length != 32 * words) revert InvalidTallyProof();

        bytes32[] memory handles = new bytes32[](words);
        for (uint256 i = 0; i < words; ++i) {
            handles[i] = FHE.toBytes32(poll.tallies[i]);
        }
        FHE.checkSignatures(handles, cleartexts, proof);

        uint64[] memory counts = new uint64[](n);
        for (uint256 j = 0; j < words; ++j) {
            uint256 word = uint256(bytes32(cleartexts[32 * j:32 * (j + 1)]));
            if (word > MAX_WORD) revert InvalidTallyProof();
            for (uint256 slot = 0; slot < COUNTERS_PER_WORD; ++slot) {
                uint256 i = j * COUNTERS_PER_WORD + slot;
                if (i >= n) break;
                // Masked to 40 bits, so the cast cannot truncate.
                // forge-lint: disable-next-line(unsafe-typecast)
                counts[i] = uint64((word >> (COUNTER_BITS * slot)) & COUNTER_MASK);
            }
        }
        poll.counts = counts;
        poll.isFinal = true;
        emit TallySubmitted(governor, token, scope, counts);
    }

    // ---- views

    /// @inheritdoc IVotingScheme
    function tallyOf(address governor, address token, uint256 scope)
        external
        view
        returns (bool isFinal, uint64[] memory counts)
    {
        Poll storage poll = _polls[governor][token][scope];
        if (poll.isFinal && poll.counts.length == 0) return (true, new uint64[](poll.optionCount));
        return (poll.isFinal, poll.counts);
    }

    /// @notice Ciphertext handles of the running packed tally words, in word order; empty until
    ///         the poll's first ballot. After `requestTally` these are publicly decryptable; the
    ///         keeper passes them to the relayer SDK `publicDecrypt` and relays the result to
    ///         `submitTally`.
    function tallyHandles(address governor, address token, uint256 scope)
        external
        view
        returns (bytes32[] memory handles)
    {
        euint128[] storage tallies = _polls[governor][token][scope].tallies;
        uint256 n = tallies.length;
        handles = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            handles[i] = euint128.unwrap(tallies[i]);
        }
    }

    /// @inheritdoc IVotingScheme
    function hasVoted(address governor, address token, uint256 scope, address voter)
        external
        view
        returns (bool)
    {
        return _polls[governor][token][scope].voted[voter];
    }

    /// @inheritdoc IVotingScheme
    function ballotCount(address governor, address token, uint256 scope)
        external
        view
        returns (uint256)
    {
        return _polls[governor][token][scope].ballotCount;
    }

    /// @inheritdoc IVotingScheme
    function isOpen(address governor, address token, uint256 scope) external view returns (bool) {
        Poll storage poll = _polls[governor][token][scope];
        return poll.opened && !poll.closed;
    }

    /// @inheritdoc IVotingScheme
    function isClosed(address governor, address token, uint256 scope) external view returns (bool) {
        return _polls[governor][token][scope].closed;
    }

    /// @inheritdoc IVotingScheme
    function optionCountOf(address governor, address token, uint256 scope)
        external
        view
        returns (uint8)
    {
        return _polls[governor][token][scope].optionCount;
    }

    /// @notice Packed tally words of a poll with `optionCount` options.
    function wordCount(uint256 optionCount) public pure returns (uint256) {
        return (optionCount + COUNTERS_PER_WORD - 1) / COUNTERS_PER_WORD;
    }

    // ---- internal

    /// @dev Adds `weight` to the counter of option `choice` without revealing it: the weight is
    ///      shifted into the option's slot once, then added to every word under an encrypted
    ///      equality test on the word index. An index past the last option lands in an unused slot
    ///      of the last word (ignored when unpacking) or in no word at all. The first ballot creates
    ///      the words: each starts as that ballot's selected contribution, which is what adding it
    ///      to an encrypted zero would give. Every ballot touches every word whatever its choice, so
    ///      creating them lazily reveals nothing about it.
    function _accumulate(Poll storage poll, euint8 choice, uint64 weight) internal {
        euint8 word = FHE.div(choice, COUNTERS_PER_WORD);
        euint8 shift = FHE.mul(FHE.rem(choice, COUNTERS_PER_WORD), COUNTER_BITS);
        euint128 shifted = FHE.shl(FHE.asEuint128(uint128(weight)), shift);
        euint128 zero = FHE.asEuint128(0);
        bool first = poll.tallies.length == 0;
        uint256 words = wordCount(poll.optionCount);
        for (uint256 j = 0; j < words; ++j) {
            // `words <= 11`, so `j` fits a uint8.
            // forge-lint: disable-next-line(unsafe-typecast)
            ebool hit = FHE.eq(word, uint8(j));
            euint128 part = FHE.select(hit, shifted, zero);
            if (first) {
                FHE.allowThis(part);
                poll.tallies.push(part);
            } else {
                euint128 updated = FHE.add(poll.tallies[j], part);
                FHE.allowThis(updated);
                poll.tallies[j] = updated;
            }
        }
    }

    /// @dev Test and measurement hook: the poll storage of `(governor, token, scope)`.
    function _pollOf(address governor, address token, uint256 scope)
        internal
        view
        returns (Poll storage)
    {
        return _polls[governor][token][scope];
    }

    /// @dev Decodes `abi.encode(bytes32, bytes)` strictly: head of two words (handle, offset 64),
    ///      a length word and the right-padded proof. Anything else, a zero handle or an empty
    ///      proof (which would bypass the sender-bound input verification) is `InvalidBallot`.
    function _decodeBallot(bytes calldata ballot)
        private
        pure
        returns (bytes32 handleRaw, bytes memory inputProof)
    {
        if (ballot.length < 96) revert InvalidBallot();
        if (uint256(bytes32(ballot[32:64])) != 64) revert InvalidBallot();
        uint256 len = uint256(bytes32(ballot[64:96]));
        if (len == 0 || len > ballot.length - 96) revert InvalidBallot();
        // Round the proof length up to whole words (bitwise, so no precision is lost).
        if (ballot.length != 96 + ((len + 31) & ~uint256(31))) revert InvalidBallot();
        handleRaw = bytes32(ballot[0:32]);
        if (handleRaw == bytes32(0)) revert InvalidBallot();
        inputProof = ballot[96:96 + len];
    }
}
