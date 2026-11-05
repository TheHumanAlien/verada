// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FheType} from "@fhevm/solidity/lib/FheType.sol";

import {IBallotGovernor, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";

/// @dev Addresses `ZamaConfig.getEthereumCoprocessorConfig()` returns on chain id 31337. Tests
///      `vm.etch` the mocks below at exactly these addresses.
library ZamaLocal {
    address internal constant ACL = 0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D;
    address internal constant EXECUTOR = 0xe3a9105a3a932253A70F126eb1E3b589C643dD24;
    address internal constant KMS_VERIFIER = 0x901F8942346f7AB3a01F6D7613119Bca447Bb030;
}

interface IMockAcl {
    function allowTransient(bytes32 handle, address account) external;
    function isAllowed(bytes32 handle, address account) external view returns (bool);
}

/// @dev Stand-in for the FHEVMExecutor coprocessor. Every operation returns a fresh deterministic
///      pseudo-handle carrying the FHE type in byte 30 and a version byte in byte 31 (the real
///      handle layout), so `checkHandleType` is meaningful. Like the real executor it requires the
///      caller to be ACL-allowed on every ciphertext operand and grants the caller a transient
///      allowance on every result. No FHE arithmetic is performed.
contract MockFhevmExecutor {
    uint8 internal constant HANDLE_VERSION = 1;

    uint256 public nonce;
    uint256 public trivialEncrypts;
    uint256 public eqs;
    uint256 public selects;
    uint256 public adds;
    uint256 public verifyInputs;

    mapping(bytes32 handle => FheType) public typeOf;
    mapping(bytes32 handle => bool) public exists;

    bytes32 public lastInputHandle;
    address public lastInputCaller;
    bytes public lastInputProof;
    FheType public lastInputType;

    error UnknownHandle(bytes32 handle);
    error WrongType(bytes32 handle, FheType expected, FheType actual);
    error NotAllowed(bytes32 handle, address account);
    error EmptyProof();

    function trivialEncrypt(uint256 ct, FheType toType) external returns (bytes32 result) {
        ++trivialEncrypts;
        result = _mint(abi.encode("trivialEncrypt", ct, toType), toType);
    }

    function fheEq(bytes32 lhs, bytes32 rhs, bytes1 scalarByte) external returns (bytes32 result) {
        ++eqs;
        _requireOperand(lhs);
        if (scalarByte == 0x00) _requireOperand(rhs);
        result = _mint(abi.encode("eq", lhs, rhs, scalarByte), FheType.Bool);
    }

    function fheAdd(bytes32 lhs, bytes32 rhs, bytes1 scalarByte) external returns (bytes32 result) {
        ++adds;
        _requireOperand(lhs);
        if (scalarByte == 0x00) {
            _requireOperand(rhs);
            if (typeOf[rhs] != typeOf[lhs]) revert WrongType(rhs, typeOf[lhs], typeOf[rhs]);
        }
        result = _mint(abi.encode("add", lhs, rhs, scalarByte), typeOf[lhs]);
    }

    function fheIfThenElse(bytes32 control, bytes32 ifTrue, bytes32 ifFalse)
        external
        returns (bytes32 result)
    {
        ++selects;
        _requireOperand(control);
        _requireOperand(ifTrue);
        _requireOperand(ifFalse);
        if (typeOf[control] != FheType.Bool) {
            revert WrongType(control, FheType.Bool, typeOf[control]);
        }
        if (typeOf[ifTrue] != typeOf[ifFalse]) {
            revert WrongType(ifFalse, typeOf[ifTrue], typeOf[ifFalse]);
        }
        result = _mint(abi.encode("select", control, ifTrue, ifFalse), typeOf[ifTrue]);
    }

    function verifyInput(
        bytes32 inputHandle,
        address callerAddress,
        bytes memory inputProof,
        FheType inputType
    ) external returns (bytes32 result) {
        ++verifyInputs;
        if (inputProof.length == 0) revert EmptyProof();
        lastInputHandle = inputHandle;
        lastInputCaller = callerAddress;
        lastInputProof = inputProof;
        lastInputType = inputType;
        result = _mint(
            abi.encode("verifyInput", inputHandle, callerAddress, inputProof, inputType), inputType
        );
    }

    function checkHandleType(bytes32 handle, FheType expectedType) external view {
        if (!exists[handle]) revert UnknownHandle(handle);
        if (typeOf[handle] != expectedType) revert WrongType(handle, expectedType, typeOf[handle]);
    }

    function getInputVerifierAddress() external pure returns (address) {
        return address(uint160(uint256(keccak256("verada.mock.inputVerifier"))));
    }

    /// @dev FHE type byte of a handle, as the real handle layout stores it.
    function handleType(bytes32 handle) external pure returns (uint8) {
        return uint8(handle[30]);
    }

    function _requireOperand(bytes32 handle) internal view {
        if (!exists[handle]) revert UnknownHandle(handle);
        if (!IMockAcl(ZamaLocal.ACL).isAllowed(handle, msg.sender)) {
            revert NotAllowed(handle, msg.sender);
        }
    }

    function _mint(bytes memory seed, FheType t) internal returns (bytes32 handle) {
        uint256 raw = uint256(keccak256(abi.encode(seed, nonce++)));
        handle = bytes32((raw & ~uint256(0xFFFF)) | (uint256(uint8(t)) << 8) | HANDLE_VERSION);
        typeOf[handle] = t;
        exists[handle] = true;
        IMockAcl(ZamaLocal.ACL).allowTransient(handle, msg.sender);
    }
}

/// @dev Stand-in for the ACL. Mirrors the real authorization rules: only the executor may grant a
///      transient allowance on a handle it is not itself allowed on; `allow` and
///      `allowForDecryption` require the caller to be allowed on the handle. "Transient"
///      allowances are plain storage here because a Foundry test runs as one transaction.
contract MockAcl {
    mapping(bytes32 handle => mapping(address account => bool)) public persistAllowed;
    mapping(bytes32 handle => mapping(address account => bool)) public transientAllowed;
    mapping(bytes32 handle => bool) public isAllowedForDecryption;
    bytes32[] public decryptable;

    error SenderNotAllowed(address sender);

    function allowTransient(bytes32 handle, address account) external {
        if (msg.sender != ZamaLocal.EXECUTOR && !isAllowed(handle, msg.sender)) {
            revert SenderNotAllowed(msg.sender);
        }
        transientAllowed[handle][account] = true;
    }

    function allow(bytes32 handle, address account) external {
        if (!isAllowed(handle, msg.sender)) revert SenderNotAllowed(msg.sender);
        persistAllowed[handle][account] = true;
    }

    function allowForDecryption(bytes32[] memory handlesList) external {
        for (uint256 i = 0; i < handlesList.length; ++i) {
            bytes32 handle = handlesList[i];
            if (!isAllowed(handle, msg.sender)) revert SenderNotAllowed(msg.sender);
            isAllowedForDecryption[handle] = true;
            decryptable.push(handle);
        }
    }

    function isAllowed(bytes32 handle, address account) public view returns (bool) {
        return persistAllowed[handle][account] || transientAllowed[handle][account];
    }

    function decryptableCount() external view returns (uint256) {
        return decryptable.length;
    }
}

/// @dev Stand-in for the KMSVerifier. `FHE.checkSignatures` calls
///      `verifyDecryptionEIP712KMSSignatures` and reverts `InvalidKMSSignatures` when it returns
///      false. Accepts by default; records the last call for assertions.
contract MockKmsVerifier {
    bool public rejectSignatures;
    uint256 public calls;
    bytes32[] internal _lastHandles;
    bytes public lastCleartexts;
    bytes public lastProof;

    function setRejectSignatures(bool reject) external {
        rejectSignatures = reject;
    }

    function verifyDecryptionEIP712KMSSignatures(
        bytes32[] memory handlesList,
        bytes memory decryptedResult,
        bytes memory decryptionProof
    ) external returns (bool) {
        ++calls;
        _lastHandles = handlesList;
        lastCleartexts = decryptedResult;
        lastProof = decryptionProof;
        return !rejectSignatures;
    }

    function lastHandles() external view returns (bytes32[] memory) {
        return _lastHandles;
    }
}

/// @dev Governor that authorizes every voter with a configurable weight, records the callback and
///      can open the poll lazily from inside `authorizeBallot`, as the real governors do.
contract MockBallotGovernor is IBallotGovernor {
    IVotingScheme public immutable scheme;
    uint64 public weight;
    bool public lazyOpen;
    uint8 public lazyOptionCount;
    bool public rejectAll;

    uint256 public authorizations;
    address public lastToken;
    uint256 public lastScope;
    address public lastVoter;
    bytes32 public lastBallotRef;

    error NotScheme(address caller);
    error VoterRejected(address voter);

    constructor(IVotingScheme scheme_, uint64 weight_) {
        scheme = scheme_;
        weight = weight_;
    }

    function setWeight(uint64 weight_) external {
        weight = weight_;
    }

    function setLazyOpen(bool enabled, uint8 optionCount) external {
        lazyOpen = enabled;
        lazyOptionCount = optionCount;
    }

    function setRejectAll(bool reject) external {
        rejectAll = reject;
    }

    function open(address token, uint256 scope, uint8 optionCount) external {
        scheme.open(token, scope, optionCount);
    }

    function requestTally(address token, uint256 scope) external {
        scheme.requestTally(token, scope);
    }

    /// @inheritdoc IBallotGovernor
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64)
    {
        if (msg.sender != address(scheme)) revert NotScheme(msg.sender);
        if (rejectAll) revert VoterRejected(voter);
        if (lazyOpen && scheme.optionCountOf(address(this), token, scope) == 0) {
            scheme.open(token, scope, lazyOptionCount);
        }
        ++authorizations;
        lastToken = token;
        lastScope = scope;
        lastVoter = voter;
        lastBallotRef = ballotRef;
        return weight;
    }
}
