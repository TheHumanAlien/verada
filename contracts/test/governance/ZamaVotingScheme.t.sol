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

    function _assertUint64Tallies(bytes32[] memory handles) internal view {
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(handles[i] != bytes32(0), "zero handle");
            assertEq(uint8(executor.typeOf(handles[i])), uint8(FheType.Uint64), "not euint64");
            assertEq(executor.handleType(handles[i]), uint8(FheType.Uint64), "type byte");
            assertTrue(acl.persistAllowed(handles[i], address(scheme)), "scheme not allowed");
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(handles[i] != handles[j], "duplicate handle");
            }
        }
    }

    // ---- deployment and governor allowlist

    function test_deploy() public view {
        assertEq(scheme.owner(), owner);
        assertEq(scheme.MAX_OPTIONS(), 10);
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
        uint8[4] memory bad = [0, 1, 11, 255];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IVotingScheme.InvalidOptionCount.selector, bad[i])
            );
            gov.open(token, SCOPE, bad[i]);
        }
    }

    function test_open_initializesEncryptedTallies() public {
        vm.expectEmit(address(scheme));
        emit IVotingScheme.PollOpened(address(gov), token, SCOPE, 3);
        gov.open(token, SCOPE, 3);

        assertTrue(scheme.isOpen(address(gov), token, SCOPE));
        assertFalse(scheme.isClosed(address(gov), token, SCOPE));
        assertEq(scheme.optionCountOf(address(gov), token, SCOPE), 3);
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 0);

        bytes32[] memory handles = _handles();
        assertEq(handles.length, 3);
        _assertUint64Tallies(handles);
        assertEq(executor.trivialEncrypts(), 3);
        for (uint256 i = 0; i < handles.length; ++i) {
            assertFalse(acl.isAllowedForDecryption(handles[i]));
        }
    }

    function test_open_acceptsBounds() public {
        gov.open(token, 1, 2);
        gov.open(token, 2, 10);
        assertEq(_handlesOf(1).length, 2);
        assertEq(_handlesOf(2).length, 10);
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

        // One eq/select/add per option; every tally was replaced and re-allowed.
        assertEq(executor.eqs(), 3);
        assertEq(executor.selects(), 3);
        assertEq(executor.adds(), 3);
        bytes32[] memory after_ = _handles();
        _assertUint64Tallies(after_);
        for (uint256 i = 0; i < 3; ++i) {
            assertTrue(after_[i] != before[i], "tally not updated");
        }
    }

    function test_castBallot_multipleVoters() public {
        gov.open(token, SCOPE, 2);
        _cast(voter, HANDLE);
        _cast(voter2, bytes32(uint256(2)));
        assertEq(scheme.ballotCount(address(gov), token, SCOPE), 2);
        assertTrue(scheme.hasVoted(address(gov), token, SCOPE, voter));
        assertTrue(scheme.hasVoted(address(gov), token, SCOPE, voter2));
        assertEq(executor.verifyInputs(), 2);
        assertEq(executor.adds(), 4);
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
        assertEq(_handles().length, 4);
        _assertUint64Tallies(_handles());

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
        weight = uint64(bound(weight, 1, type(uint64).max));
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
        assertEq(acl.decryptableCount(), 3);
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(acl.isAllowedForDecryption(handles[i]), "not decryptable");
            assertEq(acl.decryptable(i), handles[i], "order");
        }
        // Handles are frozen once closed.
        assertEq(keccak256(abi.encode(_handles())), keccak256(abi.encode(handles)));
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

    function test_submitTally_happyPath() public {
        bytes32[] memory handles = _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(uint256(5), uint256(7));
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
        assertEq(seen.length, 2);
        assertEq(seen[0], handles[0]);
        assertEq(seen[1], handles[1]);
        assertEq(kms.lastCleartexts(), cleartexts);
        assertEq(kms.lastProof(), proof);
    }

    function test_submitTally_acceptsMaxUint64() public {
        _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(uint256(type(uint64).max), uint256(0));
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
        (, uint64[] memory counts) = scheme.tallyOf(address(gov), token, SCOPE);
        assertEq(counts[0], type(uint64).max);
        assertEq(counts[1], 0);
    }

    function test_submitTally_revertsWhenNotClosed() public {
        gov.open(token, SCOPE, 2);
        vm.expectRevert(
            abi.encodeWithSelector(IVotingScheme.PollNotClosed.selector, address(gov), token, SCOPE)
        );
        scheme.submitTally(
            address(gov), token, SCOPE, abi.encode(uint256(5), uint256(7)), _kmsProof()
        );
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
        bad[1] = abi.encode(uint256(5));
        bad[2] = abi.encode(uint256(5), uint256(7), uint256(9));
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
        scheme.submitTally(
            address(gov), token, SCOPE, abi.encode(uint256(5), uint256(7)), _kmsProof()
        );
        (bool isFinal,) = scheme.tallyOf(address(gov), token, SCOPE);
        assertFalse(isFinal);
    }

    function test_submitTally_revertsOnValueAboveUint64() public {
        _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(uint256(5), uint256(type(uint64).max) + 1);
        vm.expectRevert(IVotingScheme.InvalidTallyProof.selector);
        scheme.submitTally(address(gov), token, SCOPE, cleartexts, _kmsProof());
    }

    function test_submitTally_revertsWhenAlreadyFinal() public {
        _closedTwoOptionPoll();
        bytes memory cleartexts = abi.encode(uint256(5), uint256(7));
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
