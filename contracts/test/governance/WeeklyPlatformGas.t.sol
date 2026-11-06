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

/// @notice Weekly platform (keeper-paid) gas per token and a voter's `castBallot`, with 32-option
///         catalogue ballots on the real `EpochGovernor` and `ZamaVotingScheme` over the mocked
///         coprocessor. Every figure is a whole transaction: 21,000 + calldata + execution, with
///         every touched account and slot cold (keeper transactions are days apart).
///
///         - idle: no fees, ballots, pins or launch. Before, the keeper opened the epoch and
///           finalized it without ballots; after, it only finalizes the never-opened epoch.
///         - traded, no votes: open + finalize without ballots (trading is user-paid).
///         - traded and voted: open + close + submitTally + finalize with the ballot's org ids.
///
///         `BEFORE_*` are the same measurements on main (8b7341d: options stored as `bytes32[]`,
///         eager tally words, every epoch opened), taken with this harness adapted to main's
///         `finalizeEpoch(token, epoch)`. The mock coprocessor's eager `open` costs more than the
///         live one, so `test_gas_weekly_liveAdjusted` swaps the scheme's `open` and
///         `requestTally` for the mainnet-fork figures of `test_fork_openCloseCost32`.
contract WeeklyPlatformGasTest is BallotLog {
    uint256 internal constant BEFORE_PREPARE = 2_928_723;
    uint256 internal constant BEFORE_FINALIZE_NO_VOTES = 63_189;
    uint256 internal constant BEFORE_FINALIZE_NEVER_OPENED = 78_160;
    uint256 internal constant BEFORE_CLOSE = 695_839;
    uint256 internal constant BEFORE_SUBMIT_TALLY = 682_256;
    uint256 internal constant BEFORE_FINALIZE_VOTED = 451_675;
    uint256 internal constant BEFORE_FIRST_BALLOT = 4_111_384;
    uint256 internal constant BEFORE_LATER_BALLOT = 3_846_784;
    /// @dev Main's scheme `open` (eager words) and `requestTally` with ballots on the mock
    ///      coprocessor, execution only.
    uint256 internal constant BEFORE_MOCK_OPEN = 1_391_786;
    uint256 internal constant BEFORE_MOCK_REQUEST_TALLY = 663_514;

    /// @dev `test_fork_openCloseCost32` (mainnet fork, cold accounts), execution only.
    uint256 internal constant LIVE_OPEN_EAGER = 525_889;
    uint256 internal constant LIVE_OPEN_LAZY = 30_114;
    uint256 internal constant LIVE_REQUEST_TALLY = 371_801;

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

    /// @dev Intrinsic + calldata + execution gas of one call, sent by `from`, from cold storage.
    function _tx(address from, address to, bytes memory data) internal returns (uint256) {
        _coolAll();
        vm.startPrank(from);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = to.call(data);
        uint256 used = before - gasleft();
        vm.stopPrank();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return _intrinsic(data) + used;
    }

    function _coolAll() internal {
        vm.cool(address(gov));
        vm.cool(address(zama));
        vm.cool(address(registry));
        vm.cool(address(cat.catalog()));
        vm.cool(token);
        vm.cool(ZamaLocal.EXECUTOR);
        vm.cool(ZamaLocal.ACL);
        vm.cool(ZamaLocal.KMS_VERIFIER);
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _prepare(uint256 epoch) internal returns (uint256 gas) {
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, epoch, uint64(1) << 2, 1);
        gas = _tx(address(this), address(gov), abi.encodeCall(gov.prepareBallot, (token, epoch, d)));
        assertEq(zama.optionCountOf(address(gov), token, epoch), 32);
    }

    /// @dev The keeper's finalize: the ballot's org ids only when there are ballots to tally.
    function _finalize(uint256 epoch) internal returns (uint256) {
        bytes32[] memory orgIds = gov.voterCount(token, epoch) != 0
            ? _orgIds(address(gov), token, epoch)
            : new bytes32[](0);
        return _tx(
            address(this), address(gov), abi.encodeCall(gov.finalizeEpoch, (token, epoch, orgIds))
        );
    }

    struct Week {
        uint256 prepare;
        uint256 finalizeNoVotes;
        uint256 finalizeNeverOpened;
        uint256 close;
        uint256 submitTally;
        uint256 finalizeVoted;
        uint256 firstBallot;
        uint256 laterBallot;
        uint256 mockOpen;
        uint256 mockRequestTally;
    }

    /// @dev Epoch 1 opened without ballots, epoch 2 never opened, epoch 3 voted by three voters.
    function _measure() internal returns (Week memory w) {
        w.prepare = _prepare(1);
        vm.warp(gov.epochStart(2));
        w.finalizeNoVotes = _finalize(1);
        assertEq(gov.winningCause(token, 1), fallbackCause);

        vm.warp(gov.epochStart(3));
        w.finalizeNeverOpened = _finalize(2);
        assertEq(gov.winningCause(token, 2), fallbackCause);

        _prepare(3);
        for (uint256 i; i < voters.length; ++i) {
            bytes32 handle = keccak256(abi.encode("in", i));
            executor.setInputValue(handle, uint8(7 + i));
            uint256 g = _tx(
                voters[i],
                address(zama),
                abi.encodeCall(
                    zama.castBallot, (address(gov), token, 3, abi.encode(handle, hex"01"))
                )
            );
            if (i == 0) w.firstBallot = g;
            if (i == 1) w.laterBallot = g;
        }
        vm.warp(gov.epochStart(4));
        uint256 snap = vm.snapshotState();
        bytes memory req = abi.encodeCall(zama.requestTally, (token, 3));
        w.mockRequestTally = _tx(address(gov), address(zama), req) - _intrinsic(req);
        vm.revertToState(snap);
        w.close = _tx(address(this), address(gov), abi.encodeCall(gov.closeEpoch, (token, 3)));
        bytes32[] memory words = zama.tallyHandles(address(gov), token, 3);
        bytes memory cleartexts;
        for (uint256 j; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        w.submitTally = _tx(
            address(this),
            address(zama),
            abi.encodeCall(
                zama.submitTally,
                (address(gov), token, 3, cleartexts, abi.encodePacked(uint8(1), new bytes(65)))
            )
        );
        w.finalizeVoted = _finalize(3);
        assertEq(gov.winningCause(token, 3), _options(address(gov), token, 3)[9]);

        vm.prank(owner);
        zama.setGovernor(address(this), true);
        bytes memory open = abi.encodeCall(zama.open, (token, 99, 32));
        w.mockOpen = _tx(address(this), address(zama), open) - _intrinsic(open);
    }

    function _row(string memory label, uint256 before, uint256 afterGas) internal {
        emit log_string(label);
        emit log_named_uint("  before (main)", before);
        emit log_named_uint("  after", afterGas);
        if (afterGas <= before) {
            emit log_named_uint("  saved", before - afterGas);
            emit log_named_uint("  saved (bps)", ((before - afterGas) * 10_000) / before);
        } else {
            emit log_named_uint("  extra", afterGas - before);
        }
    }

    function _beforeNoVotes() internal pure returns (uint256) {
        return BEFORE_PREPARE + BEFORE_FINALIZE_NO_VOTES;
    }

    function _beforeVoted() internal pure returns (uint256) {
        return BEFORE_PREPARE + BEFORE_CLOSE + BEFORE_SUBMIT_TALLY + BEFORE_FINALIZE_VOTED;
    }

    function test_gas_weekly_platformTotals() public {
        Week memory w = _measure();
        uint256 noVotes = w.prepare + w.finalizeNoVotes;
        uint256 voted = w.prepare + w.close + w.submitTally + w.finalizeVoted;
        emit log_named_uint("mock scheme open (execution)", w.mockOpen);
        emit log_named_uint("mock scheme requestTally with ballots (execution)", w.mockRequestTally);
        _row("prepareBallot (32 options)", BEFORE_PREPARE, w.prepare);
        _row("finalizeEpoch, opened without ballots", BEFORE_FINALIZE_NO_VOTES, w.finalizeNoVotes);
        _row("finalizeEpoch, never opened", BEFORE_FINALIZE_NEVER_OPENED, w.finalizeNeverOpened);
        _row("closeEpoch", BEFORE_CLOSE, w.close);
        _row("submitTally (11 words)", BEFORE_SUBMIT_TALLY, w.submitTally);
        _row("finalizeEpoch, voted", BEFORE_FINALIZE_VOTED, w.finalizeVoted);
        // Before, the keeper opened an idle token's epoch like any other.
        _row("idle token-week", _beforeNoVotes(), w.finalizeNeverOpened);
        _row("traded, no votes, token-week", _beforeNoVotes(), noVotes);
        _row("traded and voted, token-week", _beforeVoted(), voted);
        _row("castBallot, first voter", BEFORE_FIRST_BALLOT, w.firstBallot);
        _row("castBallot, later voter", BEFORE_LATER_BALLOT, w.laterBallot);

        assertLt(w.finalizeNeverOpened, 100_000);
        assertLt(noVotes, _beforeNoVotes());
        assertLt(voted, _beforeVoted());
        // The first voter creates the tally words: at most one fresh slot per word plus the length.
        assertLt(w.firstBallot, BEFORE_FIRST_BALLOT + 12 * 22_100);
        assertApproxEqRel(w.laterBallot, BEFORE_LATER_BALLOT, 0.02e18);
    }

    /// @dev The same weeks with the scheme's `open` and `requestTally` at live mainnet cost.
    function test_gas_weekly_liveAdjusted() public {
        Week memory w = _measure();
        uint256 beforeNoVotes = _beforeNoVotes() + LIVE_OPEN_EAGER - BEFORE_MOCK_OPEN;
        uint256 beforeVoted = _beforeVoted() + LIVE_OPEN_EAGER + LIVE_REQUEST_TALLY
            - BEFORE_MOCK_OPEN - BEFORE_MOCK_REQUEST_TALLY;
        uint256 noVotes = w.prepare + w.finalizeNoVotes + LIVE_OPEN_LAZY - w.mockOpen;
        uint256 voted = w.prepare + w.close + w.submitTally + w.finalizeVoted + LIVE_OPEN_LAZY
            + LIVE_REQUEST_TALLY - w.mockOpen - w.mockRequestTally;
        _row("live: idle token-week", beforeNoVotes, w.finalizeNeverOpened);
        _row("live: traded, no votes, token-week", beforeNoVotes, noVotes);
        _row("live: traded and voted, token-week", beforeVoted, voted);
        assertLt(noVotes, beforeNoVotes);
        assertLt(voted, beforeVoted);
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
