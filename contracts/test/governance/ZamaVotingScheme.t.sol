// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {FheType} from "@fhevm/solidity/lib/FheType.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {
    MockAcl,
    MockBallotGovernor,
    MockFhevmExecutor,
    MockKmsVerifier,
    ZamaLocal
} from "../mocks/ZamaMocks.sol";

contract ZamaVotingSchemeTest is Test {
    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    MockAcl internal acl = MockAcl(ZamaLocal.ACL);
    MockKmsVerifier internal kms = MockKmsVerifier(ZamaLocal.KMS_VERIFIER);
    ZamaVotingScheme internal scheme;
    MockBallotGovernor internal gov;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal voter = makeAddr("voter");
    address internal voter2 = makeAddr("voter2");
    address internal token = makeAddr("token");
    uint256 internal constant SCOPE = 7;
    uint64 internal constant WEIGHT = 1000;
    bytes32 internal constant HANDLE = bytes32(uint256(0xC0FFEE));
    bytes internal constant PROOF = hex"0102030405060708090a0b0c0d0e0f10";

    /// @dev Emitted by the FHE library from the scheme when the KMS proof verifies.
    event PublicDecryptionVerified(bytes32[] handlesList, bytes abiEncodedCleartexts);

    function setUp() public {
        // `ZamaConfig.getEthereumCoprocessorConfig()` returns these addresses on chain id 31337.
        assertEq(block.chainid, 31_337);
        vm.etch(ZamaLocal.EXECUTOR, type(MockFhevmExecutor).runtimeCode);
        vm.etch(ZamaLocal.ACL, type(MockAcl).runtimeCode);
        vm.etch(ZamaLocal.KMS_VERIFIER, type(MockKmsVerifier).runtimeCode);
        vm.label(ZamaLocal.EXECUTOR, "FHEVMExecutor");
        vm.label(ZamaLocal.ACL, "ACL");
        vm.label(ZamaLocal.KMS_VERIFIER, "KMSVerifier");

        scheme = new ZamaVotingScheme(owner);
        gov = new MockBallotGovernor(scheme, WEIGHT);
        vm.prank(owner);
        scheme.setGovernor(address(gov), true);
    }

    // ---- helpers

    function _ballot(bytes32 handle) internal pure returns (bytes memory) {
        return abi.encode(handle, PROOF);
    }

    function _ref(address voter_, bytes32 handle) internal view returns (bytes32) {
        return keccak256(abi.encode(address(gov), token, SCOPE, voter_, handle));
    }

    function _cast(address voter_, bytes32 handle) internal returns (bytes32) {
        vm.prank(voter_);
        return scheme.castBallot(address(gov), token, SCOPE, _ballot(handle));
    }

    function _kmsProof() internal pure returns (bytes memory) {
        // numSigners || 65-byte signature || extraData; the mock verifier does not parse it.
        return abi.encodePacked(uint8(1), new bytes(65), hex"00");
    }

    function _handles() internal view returns (bytes32[] memory) {
        return scheme.tallyHandles(address(gov), token, SCOPE);
    }

    function _assertUint128Words(bytes32[] memory handles) internal view {
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(handles[i] != bytes32(0), "zero handle");
            assertEq(uint8(executor.typeOf(handles[i])), uint8(FheType.Uint128), "not euint128");
            assertEq(executor.handleType(handles[i]), uint8(FheType.Uint128), "type byte");
            assertTrue(acl.persistAllowed(handles[i], address(scheme)), "scheme not allowed");
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(handles[i] != handles[j], "duplicate handle");
            }
        }
    }

    // ---- deployment and governor allowlist

    function test_deploy() public view {
        assertEq(scheme.owner(), owner);
        assertEq(scheme.MAX_OPTIONS(), 32);
        assertEq(scheme.COUNTER_BITS(), 40);
        assertEq(scheme.COUNTERS_PER_WORD(), 3);
        assertTrue(scheme.isGovernor(address(gov)));
        assertFalse(scheme.isGovernor(stranger));
    }

    function test_setGovernor_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        scheme.setGovernor(stranger, true);
    }

    function test_setGovernor_togglesAndEmits() public {
        vm.expectEmit(address(scheme));
        emit IVotingScheme.GovernorSet(stranger, true);
        vm.prank(owner);
        scheme.setGovernor(stranger, true);
        assertTrue(scheme.isGovernor(stranger));

        vm.expectEmit(address(scheme));
        emit IVotingScheme.GovernorSet(stranger, false);
        vm.prank(owner);
        scheme.setGovernor(stranger, false);
        assertFalse(scheme.isGovernor(stranger));
    }

    // ---- open

    function test_open_revertsForNonGovernor() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVotingScheme.NotGovernor.selector, stranger));
        scheme.open(token, SCOPE, 2);
    }

    function test_open_revertsOnInvalidOptionCount() public {
        uint8[4] memory bad = [0, 1, 33, 255];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IVotingScheme.InvalidOptionCount.selector, bad[i])
            );
            gov.open(token, SCOPE, bad[i]);
        }
    }

    function test_open_recordsPollWithoutTouchingTheCoprocessor() public {
        vm.expectEmit(address(scheme));
        emit IVotingScheme.PollOpened(address(gov), token, SCOPE, 3);
        gov.open(token, SCOPE, 3);

        assertTrue(scheme.isOpen(address(gov), token, SCOPE));
        assertFalse(scheme.isClosed(address(gov), token, SCOPE));
        assertEq(scheme.optionCountOf(address(gov), token, SCOPE), 3);
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 0);

        // The tally words are created by the first ballot, not by `open`.
        assertEq(_handles().length, 0);
        assertEq(executor.nonce(), 0, "no FHE operation at open");
        assertEq(acl.decryptableCount(), 0);
    }

    function test_open_acceptsBounds() public {
        gov.open(token, 1, 2);
        gov.open(token, 2, 10);
        gov.open(token, 3, 32);
        assertEq(_handlesOf(1).length, 0);
        assertEq(_handlesOf(3).length, 0);
        assertEq(scheme.optionCountOf(address(gov), token, 3), 32);
        assertEq(scheme.wordCount(32), 11);
        assertEq(scheme.wordCount(31), 11);
        assertEq(scheme.wordCount(30), 10);
        assertEq(scheme.wordCount(10), 4);
        assertEq(scheme.wordCount(2), 1);
    }

    function test_firstBallot_createsEveryTallyWord() public {
        uint8[3] memory sizes = [2, 10, 32];
        for (uint256 i; i < sizes.length; ++i) {
            gov.open(token, i + 1, sizes[i]);
            vm.prank(voter);
            scheme.castBallot(address(gov), token, i + 1, _ballot(HANDLE));
            bytes32[] memory words = _handlesOf(i + 1);
            assertEq(words.length, scheme.wordCount(sizes[i]));
            _assertUint128Words(words);
        }
    }

    function test_firstBallot_writesItsContributionWithoutAdding() public {
        gov.open(token, SCOPE, 5); // two words
        executor.setInputValue(HANDLE, 4); // word 1, slot 1
        _cast(voter, HANDLE);
        assertEq(executor.adds(), 0, "first ballot needs no add");
        assertEq(executor.selects(), 2);
        assertEq(executor.eqs(), 2);
        bytes32[] memory words = _handles();
        assertEq(executor.valueOf(words[0]), 0);
        assertEq(executor.valueOf(words[1]), uint256(WEIGHT) << 40);

        // The second ballot adds into the words the first one created.
        bytes32 second = bytes32(uint256(2));
        executor.setInputValue(second, 0);
        _cast(voter2, second);
        assertEq(executor.adds(), 2);
        bytes32[] memory after_ = _handles();
        assertTrue(after_[0] != words[0] && after_[1] != words[1], "words not replaced");
        assertEq(executor.valueOf(after_[0]), WEIGHT);
        assertEq(executor.valueOf(after_[1]), uint256(WEIGHT) << 40);
    }

    function test_open_revertsWhenAlreadyOpen() public {
        gov.open(token, SCOPE, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVotingScheme.PollAlreadyOpen.selector, address(gov), token, SCOPE
            )
        );
        gov.open(token, SCOPE, 2);
    }

    function test_open_pollsAreKeyedByGovernorTokenAndScope() public {
        MockBallotGovernor gov2 = new MockBallotGovernor(scheme, WEIGHT);
        vm.prank(owner);
        scheme.setGovernor(address(gov2), true);
        address token2 = makeAddr("token2");

        gov.open(token, SCOPE, 2);
        gov.open(token, SCOPE + 1, 3);
        gov.open(token2, SCOPE, 4);
        gov2.open(token, SCOPE, 5);

        assertEq(scheme.optionCountOf(address(gov), token, SCOPE), 2);
        assertEq(scheme.optionCountOf(address(gov), token, SCOPE + 1), 3);
        assertEq(scheme.optionCountOf(address(gov), token2, SCOPE), 4);
        assertEq(scheme.optionCountOf(address(gov2), token, SCOPE), 5);
        assertEq(scheme.optionCountOf(address(gov2), token2, SCOPE), 0);
        assertFalse(scheme.isOpen(address(gov2), token2, SCOPE));
    }

    // ---- castBallot

    function test_castBallot_recordsEncryptedBallot() public {
        gov.open(token, SCOPE, 3);
        bytes32[] memory before = _handles();
        bytes32 expectedRef = _ref(voter, HANDLE);

        vm.expectEmit(address(scheme));
        emit IVotingScheme.BallotCast(address(gov), token, SCOPE, voter, WEIGHT, expectedRef);
        bytes32 ref = _cast(voter, HANDLE);

        assertEq(ref, expectedRef);
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 1);
        assertTrue(scheme.hasVoted(address(gov), token, SCOPE, voter));
        assertFalse(scheme.hasVoted(address(gov), token, SCOPE, voter2));

        // The governor was consulted with the voter and the ballot reference.
        assertEq(gov.authorizations(), 1);
        assertEq(gov.lastVoter(), voter);
        assertEq(gov.lastBallotRef(), expectedRef);
        assertEq(gov.lastToken(), token);
        assertEq(gov.lastScope(), SCOPE);

        // The input proof was verified for the voter (msg.sender of castBallot) as an euint8.
        assertEq(executor.verifyInputs(), 1);
        assertEq(executor.lastInputHandle(), HANDLE);
        assertEq(executor.lastInputCaller(), voter);
        assertEq(executor.lastInputProof(), PROOF);
        assertEq(uint8(executor.lastInputType()), uint8(FheType.Uint8));

        // One div/rem/mul/shl to place the weight, then one eq/select per word; the first
        // ballot creates the word (no add) and allows it to the scheme.
        assertEq(before.length, 0);
        assertEq(executor.divs(), 1);
        assertEq(executor.rems(), 1);
        assertEq(executor.muls(), 1);
        assertEq(executor.shls(), 1);
        assertEq(executor.eqs(), 1);
        assertEq(executor.selects(), 1);
        assertEq(executor.adds(), 0);
        bytes32[] memory after_ = _handles();
        assertEq(after_.length, 1);
        _assertUint128Words(after_);
    }

    function test_castBallot_multipleVoters() public {
        gov.open(token, SCOPE, 2);
        _cast(voter, HANDLE);
        _cast(voter2, bytes32(uint256(2)));
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 2);
        assertTrue(scheme.hasVoted(address(gov), token, SCOPE, voter));
        assertTrue(scheme.hasVoted(address(gov), token, SCOPE, voter2));
        assertEq(executor.verifyInputs(), 2);
        // One word: the first ballot creates it, the second adds to it.
        assertEq(executor.adds(), 1);
    }

    function test_castBallot_ballotRefDependsOnHandleAndVoter() public {
        gov.open(token, SCOPE, 2);
        bytes32 a = _cast(voter, HANDLE);
        bytes32 b = _cast(voter2, HANDLE);
        assertTrue(a != b);
        assertEq(b, _ref(voter2, HANDLE));
    }

    function test_castBallot_revertsForUnknownGovernor() public {
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(IVotingScheme.NotGovernor.selector, stranger));
        scheme.castBallot(stranger, token, SCOPE, _ballot(HANDLE));
    }

    function test_castBallot_lazilyOpensPoll() public {
        gov.setLazyOpen(true, 4);
        assertFalse(scheme.isOpen(address(gov), token, SCOPE));

        vm.expectEmit(address(scheme));
        emit IVotingScheme.PollOpened(address(gov), token, SCOPE, 4);
        vm.expectEmit(address(scheme));
        emit IVotingScheme.BallotCast(
            address(gov), token, SCOPE, voter, WEIGHT, _ref(voter, HANDLE)
        );
        _cast(voter, HANDLE);

        assertTrue(scheme.isOpen(address(gov), token, SCOPE));
        assertEq(scheme.optionCountOf(address(gov), token, SCOPE), 4);
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 1);
        assertEq(_handles().length, 2);
        _assertUint128Words(_handles());

        // A second voter does not re-open.
        _cast(voter2, HANDLE);
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 2);
    }

    function test_castBallot_revertsWhenPollNotOpen() public {
        vm.prank(voter);
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollNotOpen.selector, address(gov), token, SCOPE)
        );
        scheme.castBallot(address(gov), token, SCOPE, _ballot(HANDLE));
    }

    function test_castBallot_revertsWhenPollClosed() public {
        gov.open(token, SCOPE, 2);
        gov.requestTally(token, SCOPE);
        vm.prank(voter);
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollClosed.selector, address(gov), token, SCOPE)
        );
        scheme.castBallot(address(gov), token, SCOPE, _ballot(HANDLE));
    }

    function test_castBallot_revertsOnZeroWeight() public {
        gov.open(token, SCOPE, 2);
        gov.setWeight(0);
        vm.prank(voter);
        vm.expectRevert(IVotingScheme.ZeroWeight.selector);
        scheme.castBallot(address(gov), token, SCOPE, _ballot(HANDLE));
        assertFalse(scheme.hasVoted(address(gov), token, SCOPE, voter));
    }

    function test_castBallot_revertsWhenAlreadyVoted() public {
        gov.open(token, SCOPE, 2);
        _cast(voter, HANDLE);
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(IVotingScheme.AlreadyVoted.selector, voter));
        scheme.castBallot(address(gov), token, SCOPE, _ballot(bytes32(uint256(99))));
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 1);
    }

    function test_castBallot_bubblesGovernorRevert() public {
        gov.open(token, SCOPE, 2);
        gov.setRejectAll(true);
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(MockBallotGovernor.VoterRejected.selector, voter));
        scheme.castBallot(address(gov), token, SCOPE, _ballot(HANDLE));
    }

    function test_castBallot_revertsOnMalformedBallot() public {
        gov.open(token, SCOPE, 2);
        bytes[] memory bad = new bytes[](7);
        bad[0] = "";
        bad[1] = abi.encode(HANDLE); // handle only
        bad[2] = abi.encodePacked(HANDLE, PROOF); // packed, no offset or length words
        bad[3] = abi.encode(HANDLE, bytes("")); // empty proof
        bad[4] = abi.encode(bytes32(0), PROOF); // zero handle
        bad[5] = abi.encodePacked(HANDLE, uint256(96), uint256(PROOF.length), PROOF); // bad offset
        bytes memory inconsistent = abi.encode(HANDLE, PROOF);
        bad[6] = abi.encodePacked(inconsistent, hex"00"); // trailing byte
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(voter);
            vm.expectRevert(IVotingScheme.InvalidBallot.selector);
            scheme.castBallot(address(gov), token, SCOPE, bad[i]);
        }
        assertEq(gov.authorizations(), 0, "decoding happens before the governor call");
    }

    function test_castBallot_lengthWordLargerThanBodyIsInvalid() public {
        gov.open(token, SCOPE, 2);
        bytes memory bad = abi.encodePacked(HANDLE, uint256(64), type(uint256).max, PROOF);
        vm.prank(voter);
        vm.expectRevert(IVotingScheme.InvalidBallot.selector);
        scheme.castBallot(address(gov), token, SCOPE, bad);
    }

    function test_castBallot_acceptsProofOfAnyLength() public {
        gov.open(token, SCOPE, 2);
        bytes memory longProof = new bytes(1000);
        longProof[999] = 0xAB;
        vm.prank(voter);
        scheme.castBallot(address(gov), token, SCOPE, abi.encode(HANDLE, longProof));
        assertEq(executor.lastInputProof(), longProof);
    }

    function testFuzz_castBallot(uint64 weight, uint256 scope, bytes32 handle, address voter_)
        public
    {
        weight = uint64(bound(weight, 1, scheme.MAX_WEIGHT()));
        vm.assume(handle != bytes32(0));
        vm.assume(voter_ != address(0));
        gov.setWeight(weight);
        gov.open(token, scope, 2);

        vm.prank(voter_);
        bytes32 ref = scheme.castBallot(address(gov), token, scope, _ballot(handle));

        assertEq(ref, keccak256(abi.encode(address(gov), token, scope, voter_, handle)));
        assertTrue(scheme.hasVoted(address(gov), token, scope, voter_));
        assertEq(scheme.ballotCount(address(gov), token, scope), 1);
        assertEq(executor.lastInputCaller(), voter_);
    }

    // ---- requestTally

    function test_requestTally_revertsForNonGovernor() public {
        gov.open(token, SCOPE, 2);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVotingScheme.NotGovernor.selector, stranger));
        scheme.requestTally(token, SCOPE);
    }

    function test_requestTally_revertsWhenNotOpen() public {
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollNotOpen.selector, address(gov), token, SCOPE)
        );
        gov.requestTally(token, SCOPE);
    }

    function test_requestTally_makesTalliesPubliclyDecryptable() public {
        gov.open(token, SCOPE, 3);
        _cast(voter, HANDLE);
        bytes32[] memory handles = _handles();

        vm.expectEmit(address(scheme));
        emit IVotingScheme.TallyRequested(address(gov), token, SCOPE);
        gov.requestTally(token, SCOPE);

        assertTrue(scheme.isClosed(address(gov), token, SCOPE));
        assertFalse(scheme.isOpen(address(gov), token, SCOPE));
        assertEq(acl.decryptableCount(), 1);
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(acl.isAllowedForDecryption(handles[i]), "not decryptable");
            assertEq(acl.decryptable(i), handles[i], "order");
        }
        // Handles are frozen once closed.
        assertEq(keccak256(abi.encode(_handles())), keccak256(abi.encode(handles)));
    }

    function test_requestTally_withoutBallotsIsFinalAtOnce() public {
        gov.open(token, SCOPE, 32);
        uint64[] memory zeros = new uint64[](32);
        vm.expectEmit(address(scheme));
        emit IVotingScheme.TallyRequested(address(gov), token, SCOPE);
        vm.expectEmit(address(scheme));
        emit IVotingScheme.TallySubmitted(address(gov), token, SCOPE, zeros);
        gov.requestTally(token, SCOPE);

        assertTrue(scheme.isClosed(address(gov), token, SCOPE));
        (bool isFinal, uint64[] memory counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertTrue(isFinal);
        assertEq(counts.length, 32);
        for (uint256 i; i < counts.length; ++i) {
            assertEq(counts[i], 0);
        }
        // Nothing to decrypt and nothing to submit.
        assertEq(_handles().length, 0);
        assertEq(acl.decryptableCount(), 0);
        assertEq(executor.nonce(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVotingScheme.TallyAlreadyFinal.selector, address(gov), token, SCOPE
            )
        );
        scheme.submitTally(address(gov), token, SCOPE, "", _kmsProof());
        assertEq(kms.calls(), 0);
    }

    function test_requestTally_revertsWhenAlreadyClosed() public {
        gov.open(token, SCOPE, 2);
        gov.requestTally(token, SCOPE);
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollClosed.selector, address(gov), token, SCOPE)
        );
        gov.requestTally(token, SCOPE);
    }

    // ---- submitTally

    function _closedTwoOptionPoll() internal returns (bytes32[] memory handles) {
        gov.open(token, SCOPE, 2);
        _cast(voter, HANDLE);
        _cast(voter2, bytes32(uint256(1)));
        gov.requestTally(token, SCOPE);
        handles = _handles();
    }

    function _word(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return a | (b << 40) | (c << 80);
    }

    function test_submitTally_happyPath() public {
        bytes32[] memory handles = _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(_word(5, 7, 0));
        bytes memory proof = _kmsProof();

        uint64[] memory expected = new uint64[](2);
        expected[0] = 5;
        expected[1] = 7;
        vm.expectEmit(address(scheme));
        emit PublicDecryptionVerified(handles, cleartexts);
        vm.expectEmit(address(scheme));
        emit IVotingScheme.TallySubmitted(address(gov), token, SCOPE, expected);
        vm.prank(stranger); // permissionless
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, proof);

        (bool isFinal, uint64[] memory counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertTrue(isFinal);
        assertEq(counts.length, 2);
        assertEq(counts[0], 5);
        assertEq(counts[1], 7);

        // The KMS verifier saw exactly the tally handles, the cleartexts and the proof.
        assertEq(kms.calls(), 1);
        bytes32[] memory seen = kms.lastHandles();
        assertEq(seen.length, 1);
        assertEq(seen[0], handles[0]);
        assertEq(kms.lastCleartexts(), cleartexts);
        assertEq(kms.lastProof(), proof);
    }

    function test_submitTally_acceptsFullCounters() public {
        _closedTwoOptionPoll();
        uint256 max = (1 << 40) - 1;
        // The unused third slot is ignored.
        bytes memory cleartexts = abi.encode(_word(max, 0, max));
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
        (, uint64[] memory counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertEq(counts.length, 2);
        assertEq(counts[0], max);
        assertEq(counts[1], 0);
    }

    function test_submitTally_revertsWhenNotClosed() public {
        gov.open(token, SCOPE, 2);
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollNotClosed.selector, address(gov), token, SCOPE)
        );
        scheme.submitTally(address(gov), token, SCOPE, abi.encode(_word(5, 7, 0)), _kmsProof());
    }

    function test_submitTally_revertsWhenNeverOpened() public {
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollNotClosed.selector, address(gov), token, SCOPE)
        );
        scheme.submitTally(address(gov), token, SCOPE, "", _kmsProof());
    }

    function test_submitTally_revertsOnWrongLength() public {
        _closedTwoOptionPoll();
        bytes[] memory bad = new bytes[](4);
        bad[0] = "";
        bad[1] = abi.encodePacked(uint128(5));
        bad[2] = abi.encode(uint256(5), uint256(7));
        bad[3] = abi.encodePacked(uint64(5), uint64(7));
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(IVotingScheme.InvalidTallyProof.selector);
            scheme.submitTally(address(gov), token, SCOPE, bad[i], _kmsProof());
        }
        assertEq(kms.calls(), 0, "length is checked before the KMS call");
    }

    function test_submitTally_revertsWhenKmsRejects() public {
        _closedTwoOptionPoll();
        kms.setRejectSignatures(true);
        vm.expectRevert(FHE.InvalidKMSSignatures.selector);
        scheme.submitTally(address(gov), token, SCOPE, abi.encode(_word(5, 7, 0)), _kmsProof());
        (bool isFinal,) = scheme.tallyOf(address(gov), token, SCOPE);
        assertFalse(isFinal);
    }

    function test_submitTally_revertsOnWordAbove120Bits() public {
        _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(uint256(1) << 120);
        vm.expectRevert(IVotingScheme.InvalidTallyProof.selector);
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
    }

    function test_submitTally_revertsWhenAlreadyFinal() public {
        _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(_word(5, 7, 0));
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
        vm.expectRevert(
            abi.encodeWithSelector(
                IVotingScheme.TallyAlreadyFinal.selector, address(gov), token, SCOPE
            )
        );
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
    }

    function test_tallyOf_emptyBeforeFinal() public {
        (bool isFinal, uint64[] memory counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertFalse(isFinal);
        assertEq(counts.length, 0);

        gov.open(token, SCOPE, 2);
        _cast(voter, HANDLE);
        gov.requestTally(token, SCOPE);
        (isFinal, counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertFalse(isFinal);
        assertEq(counts.length, 0);
    }

    // ---- gas (mocked coprocessor: symbolic handles only, not representative of mainnet)

    function test_gas_castBallot_twoOptions() public {
        _logCastGas(2);
    }

    function test_gas_castBallot_tenOptions() public {
        _logCastGas(10);
    }

    function test_gas_castBallot_thirtyTwoOptions() public {
        _logCastGas(32);
    }

    /// @dev Lazy tallies move the word creation from `open` to the first ballot; the second
    ///      ballot pays the steady-state cost. The first voter's surcharge is bounded by the word
    ///      count (at most 11 fresh storage slots).
    function test_gas_firstVsSecondBallot_thirtyTwoOptions() public {
        uint256 g = gasleft();
        gov.open(token, SCOPE, 32);
        emit log_named_uint("open gas, 32 options (lazy)", g - gasleft());
        bytes memory ballot = _ballot(HANDLE);
        vm.prank(voter);
        g = gasleft();
        scheme.castBallot(address(gov), token, SCOPE, ballot);
        uint256 first = g - gasleft();
        vm.prank(voter2);
        g = gasleft();
        scheme.castBallot(address(gov), token, SCOPE, ballot);
        uint256 second = g - gasleft();
        emit log_named_uint("first castBallot gas, 32 options (mocked coprocessor)", first);
        emit log_named_uint("second castBallot gas, 32 options (mocked coprocessor)", second);
        // 11 words x (fresh slot - warm rewrite) plus the array length slot; the saved FHE.add
        // calls offset part of it.
        assertLt(first, second + 11 * 22_100 + 22_100, "first-voter surcharge unbounded");
    }

    // ---- packed tallies, end to end through the plaintext-shadowing mock coprocessor

    function test_castBallot_revertsAboveMaxWeight() public {
        gov.open(token, SCOPE, 2);
        uint64 tooMuch = scheme.MAX_WEIGHT() + 1;
        gov.setWeight(tooMuch);
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(ZamaVotingScheme.WeightTooLarge.selector, tooMuch));
        scheme.castBallot(address(gov), token, SCOPE, _ballot(HANDLE));
    }

    /// @dev Casts `choices[i]` with `weights[i]` for distinct voters, closes the poll, decrypts the
    ///      words from the mock's plaintext shadow, submits them and returns the counts.
    function _runPoll(uint8 n, uint8[] memory choices, uint64[] memory weights)
        internal
        returns (uint64[] memory counts)
    {
        gov.open(token, SCOPE, n);
        for (uint256 i = 0; i < choices.length; ++i) {
            bytes32 handle = bytes32(uint256(keccak256(abi.encode("ballot", i))));
            executor.setInputValue(handle, choices[i]);
            gov.setWeight(weights[i]);
            _cast(address(uint160(0x1000 + i)), handle);
        }
        gov.requestTally(token, SCOPE);
        bytes32[] memory words = _handles();
        bytes memory cleartexts;
        for (uint256 j = 0; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
        bool isFinal;
        (isFinal, counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertTrue(isFinal);
    }

    function test_packedTally_countsEveryOptionOfAThirtyTwoOptionPoll() public {
        uint8[] memory choices = new uint8[](34);
        uint64[] memory weights = new uint64[](34);
        for (uint256 i = 0; i < 32; ++i) {
            choices[i] = uint8(i);
            weights[i] = uint64(i + 1);
        }
        // Out of range: an unused slot of the last word, and past every word.
        choices[32] = 32;
        weights[32] = 1000;
        choices[33] = 200;
        weights[33] = 1000;
        uint64[] memory counts = _runPoll(32, choices, weights);
        assertEq(counts.length, 32);
        for (uint256 i = 0; i < 32; ++i) {
            assertEq(counts[i], i + 1);
        }
    }

    function test_packedTally_supplySizedWeightsDoNotSpillIntoNeighbours() public {
        // 1e11 whole tokens is the whole supply of a Verada token.
        uint8[] memory choices = new uint8[](3);
        uint64[] memory weights = new uint64[](3);
        choices[0] = 1;
        weights[0] = 60_000_000_000;
        choices[1] = 1;
        weights[1] = 40_000_000_000;
        choices[2] = 2;
        weights[2] = 1;
        uint64[] memory counts = _runPoll(3, choices, weights);
        assertEq(counts[0], 0);
        assertEq(counts[1], 100_000_000_000);
        assertEq(counts[2], 1);
    }

    function testFuzz_packedTally_matchesPlainReference(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 2, 32));
        uint256 voters = bound(seed, 1, 12);
        uint8[] memory choices = new uint8[](voters);
        uint64[] memory weights = new uint64[](voters);
        uint256[] memory expected = new uint256[](n);
        for (uint256 i = 0; i < voters; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            choices[i] = uint8(r % (uint256(n) + 3)); // some out of range
            weights[i] = uint64(bound(r >> 8, 1, 8_000_000_000)); // 12 voters stay under 1e11
            if (choices[i] < n) expected[choices[i]] += weights[i];
        }
        uint64[] memory counts = _runPoll(n, choices, weights);
        assertEq(counts.length, n);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(counts[i], expected[i]);
        }
    }

    function _logCastGas(uint8 optionCount) internal {
        gov.open(token, SCOPE, optionCount);
        bytes memory ballot = _ballot(HANDLE);
        vm.prank(voter);
        uint256 before = gasleft();
        scheme.castBallot(address(gov), token, SCOPE, ballot);
        uint256 used = before - gasleft();
        emit log_named_uint("castBallot gas (mocked coprocessor), options", optionCount);
        emit log_named_uint("castBallot gas (mocked coprocessor), gas", used);
    }

    function _handlesOf(uint256 scope) internal view returns (bytes32[] memory) {
        return scheme.tallyHandles(address(gov), token, scope);
    }
}
