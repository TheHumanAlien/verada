// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite} from "../mocks/GovernanceMocks.sol";
import {MockAcl, MockFhevmExecutor, MockKmsVerifier, ZamaLocal} from "../mocks/ZamaMocks.sol";
import {BallotLog} from "../utils/BallotLog.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @notice Weekly platform (keeper-paid) gas per token with a 32-option ballot on the real
///         `ZamaVotingScheme` over the mocked coprocessor (the real coprocessor's `open` costs
///         more, about 475k on a mainnet fork; the governor's share is what changed here). Each
///         transaction counts 21,000 + calldata + execution. Idle and traded-without-votes tokens
///         send the same governor transactions (trading is user-paid); voted tokens add close,
///         tally and a finalize that carries the ballot's org ids as calldata.
///         `BEFORE_*` are the same measurements with the ballot stored as `bytes32[]` (commit
///         20e90bf).
contract WeeklyPlatformGasTest is BallotLog {
    uint256 internal constant BEFORE_PREPARE = 2_928_723;
    uint256 internal constant BEFORE_FINALIZE_NO_VOTES = 63_189;
    uint256 internal constant BEFORE_CLOSE = 695_839;
    uint256 internal constant BEFORE_SUBMIT_TALLY = 682_256;
    uint256 internal constant BEFORE_FINALIZE_VOTED = 451_675;

    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    ZamaVotingScheme internal zama;
    EpochGovernor internal gov;
    CauseRegistry internal registry;
    CatalogFixture internal cat;
    VeradaToken internal tokenContract;
    address internal token;
    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address[3] internal voters;
    bytes32 internal fallbackCause = keccak256("fallback");

    function setUp() public {
        _recordBallots();
        vm.etch(ZamaLocal.EXECUTOR, type(MockFhevmExecutor).runtimeCode);
        vm.etch(ZamaLocal.ACL, type(MockAcl).runtimeCode);
        vm.etch(ZamaLocal.KMS_VERIFIER, type(MockKmsVerifier).runtimeCode);

        vm.warp(1_750_000_123);
        tokenContract =
            new VeradaToken("Verada Test", "VTEST", "ipfs://meta", makeAddr("c"), factory);
        token = address(tokenContract);
        for (uint256 i; i < voters.length; ++i) {
            voters[i] = address(uint160(0x5000 + i));
            vm.prank(factory);
            tokenContract.transfer(voters[i], (i + 1) * 1_000_000e18);
        }
        vm.warp(block.timestamp + 7 days);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        zama = new ZamaVotingScheme(owner);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        cat = new CatalogFixture();
        for (uint256 i; i < 100; ++i) {
            cat.add(cat.bucketOf(2, 0), keccak256(abi.encode("org", i)));
        }
        cat.publish();
        gov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            IVotingScheme(address(zama)),
            ITokenProfileRegistry(address(profiles))
        );
        profiles.register(token, makeAddr("c"));
        profiles.setFocus(token, uint64(1) << 2, uint16(1));
        vm.startPrank(owner);
        zama.setGovernor(address(gov), true);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        bytes32 fallbackOrg = keccak256("fallbackOrg");
        registry.addCause(
            fallbackCause, fallbackOrg, orgFactory.computeOrgAddress(fallbackOrg), "meta"
        );
        gov.setDefaultCause(fallbackCause);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        vm.warp(gov.epochStart(1));
    }

    /// @dev Intrinsic + calldata + execution gas of one call from this contract. Keeper
    ///      transactions are days apart, so every touched contract's storage starts cold.
    function _tx(address to, bytes memory data) internal returns (uint256) {
        vm.cool(address(gov));
        vm.cool(address(zama));
        vm.cool(address(registry));
        vm.cool(address(cat.catalog()));
        vm.cool(token);
        vm.cool(ZamaLocal.EXECUTOR);
        vm.cool(ZamaLocal.ACL);
        uint256 cd;
        for (uint256 i; i < data.length; ++i) {
            cd += data[i] == 0 ? 4 : 16;
        }
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = to.call(data);
        uint256 used = before - gasleft();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return 21_000 + cd + used;
    }

    function _prepare() internal returns (uint256 gas) {
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, uint64(1) << 2, 1);
        gas = _tx(address(gov), abi.encodeCall(gov.prepareBallot, (token, 1, d)));
        assertEq(zama.optionCountOf(address(gov), token, 1), 32);
    }

    function _finalize(bytes32[] memory orgIds) internal returns (uint256) {
        return _tx(address(gov), abi.encodeCall(gov.finalizeEpoch, (token, 1, orgIds)));
    }

    function _log(string memory label, uint256 before, uint256 afterGas) internal {
        emit log_named_uint(string.concat(label, " before"), before);
        emit log_named_uint(string.concat(label, " after"), afterGas);
    }

    function test_gas_weekly_idleToken() public {
        uint256 p = _prepare();
        vm.warp(gov.epochStart(2));
        uint256 f = _finalize(new bytes32[](0));
        _log("idle: prepareBallot (32 options)", BEFORE_PREPARE, p);
        _log("idle: finalizeEpoch (no votes)", BEFORE_FINALIZE_NO_VOTES, f);
        _log("idle: weekly platform total", BEFORE_PREPARE + BEFORE_FINALIZE_NO_VOTES, p + f);
        assertLt(p + f, BEFORE_PREPARE + BEFORE_FINALIZE_NO_VOTES);
    }

    function test_gas_weekly_tradedNoVotes() public {
        uint256 p = _prepare();
        vm.warp(gov.epochStart(2));
        uint256 f = _finalize(new bytes32[](0));
        _log(
            "traded-no-votes: weekly platform total",
            BEFORE_PREPARE + BEFORE_FINALIZE_NO_VOTES,
            p + f
        );
        assertEq(gov.winningCause(token, 1), fallbackCause);
        assertLt(p + f, BEFORE_PREPARE + BEFORE_FINALIZE_NO_VOTES);
    }

    function test_gas_weekly_tradedAndVoted() public {
        uint256 p = _prepare();
        for (uint256 i; i < voters.length; ++i) {
            bytes32 handle = keccak256(abi.encode("in", i));
            executor.setInputValue(handle, uint8(7 + i));
            vm.prank(voters[i]);
            zama.castBallot(address(gov), token, 1, abi.encode(handle, hex"01"));
        }
        vm.warp(gov.epochStart(2));
        uint256 c = _tx(address(gov), abi.encodeCall(gov.closeEpoch, (token, 1)));
        bytes32[] memory words = zama.tallyHandles(address(gov), token, 1);
        bytes memory cleartexts;
        for (uint256 j; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        uint256 t = _tx(
            address(zama),
            abi.encodeCall(
                zama.submitTally,
                (address(gov), token, 1, cleartexts, abi.encodePacked(uint8(1), new bytes(65)))
            )
        );
        uint256 f = _finalize(_orgIds(address(gov), token, 1));
        _log("voted: prepareBallot (32 options)", BEFORE_PREPARE, p);
        _log("voted: closeEpoch", BEFORE_CLOSE, c);
        _log("voted: submitTally", BEFORE_SUBMIT_TALLY, t);
        _log("voted: finalizeEpoch", BEFORE_FINALIZE_VOTED, f);
        uint256 before = BEFORE_PREPARE + BEFORE_CLOSE + BEFORE_SUBMIT_TALLY + BEFORE_FINALIZE_VOTED;
        _log("voted: weekly platform total", before, p + c + t + f);
        assertEq(gov.winningCause(token, 1), _options(address(gov), token, 1)[9]);
        assertLt(p + c + t + f, before);
    }

    /// @dev Storing 32 org ids: as `bytes32[]` storage (before), as an SSTORE2 data contract,
    ///      or as one commitment slot (this design; the count packs into the epoch's flag slot).
    function test_gas_ballotStorage_options() public {
        bytes32[] memory orgs = new bytes32[](32);
        for (uint256 i; i < 32; ++i) {
            orgs[i] = keccak256(abi.encode("org", i));
        }
        uint256 g = gasleft();
        _array = orgs;
        uint256 arrayGas = g - gasleft();

        bytes memory init = abi.encodePacked(
            hex"61", uint16(orgs.length * 32 + 1), hex"80600a3d393df300", abi.encodePacked(orgs)
        );
        g = gasleft();
        address pointer;
        assembly ("memory-safe") {
            pointer := create(0, add(init, 32), mload(init))
        }
        uint256 sstore2Gas = g - gasleft();
        assertEq(pointer.code.length, 32 * 32 + 1);

        g = gasleft();
        _commitment = keccak256(abi.encodePacked(orgs));
        uint256 commitmentGas = g - gasleft();

        emit log_named_uint("store 32 org ids: bytes32[] storage", arrayGas);
        emit log_named_uint("store 32 org ids: SSTORE2 data contract", sstore2Gas);
        emit log_named_uint("store 32 org ids: keccak commitment", commitmentGas);
        assertLt(commitmentGas, sstore2Gas);
        assertLt(sstore2Gas, arrayGas);
    }

    bytes32[] internal _array;
    bytes32 internal _commitment;
}
