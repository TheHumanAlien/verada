// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, ebool, euint64, euint8, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IBallotGovernor, IVotingScheme} from "../interfaces/IVotingScheme.sol";

/// @title ZamaVotingScheme
/// @notice `IVotingScheme` whose ballots are Zama FHEVM ciphertexts. A voter submits an encrypted
///         option index (`euint8`) with its input proof; the scheme adds the voter's weight to the
///         encrypted tally of every option under an encrypted equality test, so no party learns an
///         individual choice. When the governor closes the poll the per-option tallies are made
///         publicly decryptable; anyone then relays the KMS-signed cleartexts to `submitTally`.
/// @dev Polls are keyed by `(governor, token, scope)`. Only allowlisted governors may open polls
///      and request tallies. The voter calls `castBallot` directly so that the input proof, which
///      the coprocessor binds to `msg.sender`, is checked against the voter; the governor is
///      consulted through `IBallotGovernor.authorizeBallot` and may open the poll lazily during
///      that call. Weights are whole tokens and tallies are `euint64`, matching the interface.
contract ZamaVotingScheme is IVotingScheme, Ownable2Step {
    /// @inheritdoc IVotingScheme
    uint8 public constant MAX_OPTIONS = 10;

    struct Poll {
        uint8 optionCount;
        bool opened;
        bool closed;
        bool isFinal;
        uint256 ballotCount;
        euint64[] tallies;
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
    function open(address token, uint256 scope, uint8 optionCount) external {
        if (!isGovernor[msg.sender]) revert NotGovernor(msg.sender);
        Poll storage poll = _polls[msg.sender][token][scope];
        if (poll.opened) revert PollAlreadyOpen(msg.sender, token, scope);
        if (optionCount < 2 || optionCount > MAX_OPTIONS) revert InvalidOptionCount(optionCount);

        poll.opened = true;
        poll.optionCount = optionCount;
        for (uint256 i = 0; i < optionCount; ++i) {
            euint64 zero = FHE.asEuint64(0);
            FHE.allowThis(zero);
            poll.tallies.push(zero);
        }
        emit PollOpened(msg.sender, token, scope, optionCount);
    }

    /// @inheritdoc IVotingScheme
    function requestTally(address token, uint256 scope) external {
        if (!isGovernor[msg.sender]) revert NotGovernor(msg.sender);
        Poll storage poll = _polls[msg.sender][token][scope];
        if (!poll.opened) revert PollNotOpen(msg.sender, token, scope);
        if (poll.closed) revert PollClosed(msg.sender, token, scope);

        poll.closed = true;
        uint256 n = poll.optionCount;
        for (uint256 i = 0; i < n; ++i) {
            FHE.makePubliclyDecryptable(poll.tallies[i]);
        }
        emit TallyRequested(msg.sender, token, scope);
    }

    // ---- voter

    /// @inheritdoc IVotingScheme
    /// @dev `ballot` is `abi.encode(bytes32 handle, bytes inputProof)` where `handle` is the
    ///      external `euint8` option index produced by the relayer SDK for this voter and this
    ///      contract. An out-of-range option adds nothing to any tally.
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
        if (poll.voted[msg.sender]) revert AlreadyVoted(msg.sender);

        poll.voted[msg.sender] = true;
        ++poll.ballotCount;

        // Binds the proof to msg.sender (the voter) and yields the encrypted option index.
        euint8 choice = FHE.fromExternal(externalEuint8.wrap(handleRaw), inputProof);
        euint64 w = FHE.asEuint64(weight);
        euint64 zero = FHE.asEuint64(0);
        uint256 n = poll.optionCount;
        for (uint256 i = 0; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            ebool hit = FHE.eq(choice, uint8(i));
            euint64 updated = FHE.add(poll.tallies[i], FHE.select(hit, w, zero));
            FHE.allowThis(updated);
            poll.tallies[i] = updated;
        }
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
        if (cleartexts.length != 32 * n) revert InvalidTallyProof();

        bytes32[] memory handles = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            handles[i] = FHE.toBytes32(poll.tallies[i]);
        }
        FHE.checkSignatures(handles, cleartexts, proof);

        uint64[] memory counts = new uint64[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 word = uint256(bytes32(cleartexts[32 * i:32 * (i + 1)]));
            if (word > type(uint64).max) revert InvalidTallyProof();
            // forge-lint: disable-next-line(unsafe-typecast)
            counts[i] = uint64(word);
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
        return (poll.isFinal, poll.counts);
    }

    /// @notice Ciphertext handles of the running per-option tallies, in option order. After
    ///         `requestTally` these are publicly decryptable; the keeper passes them to the relayer
    ///         SDK `publicDecrypt` and relays the result to `submitTally`.
    function tallyHandles(address governor, address token, uint256 scope)
        external
        view
        returns (bytes32[] memory handles)
    {
        euint64[] storage tallies = _polls[governor][token][scope].tallies;
        uint256 n = tallies.length;
        handles = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            handles[i] = euint64.unwrap(tallies[i]);
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

    // ---- internal

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
