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

/// @notice Weekly platform (keeper) gas per token, before and after the keeper's idle-epoch
///         policy, on the real `EpochGovernor` and `ZamaVotingScheme` with 32-option catalogue
///         ballots. Contracts are unchanged; the policy only stops the keeper opening idle
///         tokens' epochs. Every measured call starts with cold accounts and storage, and each
///         transaction is charged 21,000 plus its calldata (EIP-2028 pricing).
///
///         - idle (no fees, ballots, pin change or launch): before, open + finalize with no
///           ballots; after, finalize of the never-opened epoch only.
///         - traded, no votes: open + finalize, unchanged.
///         - traded and voted: open + close + submitTally + finalize, unchanged.
///
///         FHE work runs on the plaintext-shadowing mock coprocessor, so the Zama `open` and
///         `submitTally` figures are lower than on mainnet (the fork test measures the real ones).
contract IdleEpochsGasTest is BallotLog {
    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    ZamaVotingScheme internal zama;
    EpochGovernor internal gov;
    CauseRegistry internal registry;
    CatalogFixture internal cat;
    MockProfileRegistryLite internal profiles;
    address internal token;
    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address[3] internal voters;
    bytes32 internal constant DEFAULT_CAUSE = keccak256("default cause");
    /// @dev `test_fork_openCloseCost32` on the live mainnet coprocessor (cold accounts): the
    ///      lazy `open` and `requestTally` of a poll with ballots.
    uint256 internal constant LIVE_OPEN_32 = 30_114;
    uint256 internal constant LIVE_REQUEST_TALLY_32 = 371_801;

    function setUp() public {
        _recordBallots();
        vm.etch(ZamaLocal.EXECUTOR, type(MockFhevmExecutor).runtimeCode);
        vm.etch(ZamaLocal.ACL, type(MockAcl).runtimeCode);
        vm.etch(ZamaLocal.KMS_VERIFIER, type(MockKmsVerifier).runtimeCode);

        vm.warp(1_750_000_123);
        VeradaToken t =
            new VeradaToken("Verada Test", "VTEST", "ipfs://meta", makeAddr("c"), factory);
        token = address(t);
        for (uint256 i; i < voters.length; ++i) {
            voters[i] = address(uint160(0x5000 + i));
            vm.prank(factory);
            t.transfer(voters[i], (i + 1) * 1_000_000e18);
        }
        vm.warp(block.timestamp + 7 days);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        zama = new ZamaVotingScheme(owner);
        profiles = new MockProfileRegistryLite();
        cat = new CatalogFixture();
        for (uint256 i; i < 120; ++i) {
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
        bytes32 org = keccak256("default org");
        vm.startPrank(owner);
        zama.setGovernor(address(gov), true);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        registry.addCause(DEFAULT_CAUSE, org, orgFactory.computeOrgAddress(org), "meta");
        gov.setDefaultCause(DEFAULT_CAUSE);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
    }

    // ---------------------------------------------------------------- measurement helpers

    function _coolAll() internal {
        vm.cool(address(gov));
        vm.cool(address(zama));
        vm.cool(address(registry));
        vm.cool(address(cat.catalog()));
        vm.cool(address(profiles));
        vm.cool(token);
        vm.cool(ZamaLocal.EXECUTOR);
        vm.cool(ZamaLocal.ACL);
        vm.cool(ZamaLocal.KMS_VERIFIER);
    }

    /// @dev 21,000 + EIP-2028 calldata gas of a transaction with this calldata.
    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Total transaction gas (intrinsic + execution) of `data` sent to `target`.
    function _tx(address target, bytes memory data) internal returns (uint256) {
        _coolAll();
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        uint256 used = before - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return _intrinsic(data) + used;
    }

    function _open(uint256 epoch) internal returns (uint256) {
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, epoch, uint64(1) << 2, 1);
        uint256 g = _tx(address(gov), abi.encodeCall(gov.prepareBallot, (token, epoch, d)));
        assertEq(zama.optionCountOf(address(gov), token, epoch), 32);
        return g;
    }

    function _finalize(uint256 epoch) internal returns (uint256) {
        // The keeper sends the ballot's org ids only when the epoch has ballots to tally.
        bytes32[] memory orgIds =
            gov.voterCount(token, epoch) != 0 ? _orgIds(address(gov), token, epoch) : new bytes32[](0);
        return _tx(address(gov), abi.encodeCall(gov.finalizeEpoch, (token, epoch, orgIds)));
    }

    // ---------------------------------------------------------------- per-token weekly costs

    struct Weekly {
        uint256 idleBefore;
        uint256 idleAfter;
        uint256 tradedNoVotes;
        uint256 voted;
        /// Mock-coprocessor gas of the scheme's `open` and `requestTally` inside the above.
        uint256 mockOpen;
        uint256 mockRequestTally;
    }

    /// @dev The same week with the scheme's open and close at live mainnet coprocessor cost.
    function _live(Weekly memory w) internal pure returns (Weekly memory l) {
        l.idleBefore = w.idleBefore + LIVE_OPEN_32 - w.mockOpen;
        l.idleAfter = w.idleAfter;
        l.tradedNoVotes = w.tradedNoVotes + LIVE_OPEN_32 - w.mockOpen;
        l.voted = w.voted + LIVE_OPEN_32 + LIVE_REQUEST_TALLY_32 - w.mockOpen - w.mockRequestTally;
    }

    function _measure() internal returns (Weekly memory w) {
        // Epoch 1: what the keeper paid for an idle token before, open + finalize without ballots.
        // The same transactions are a traded token's week when nobody votes.
        vm.warp(gov.epochStart(1));
        uint256 open1 = _open(1);
        vm.warp(gov.epochStart(2));
        uint256 finNoVotes = _finalize(1);
        w.idleBefore = open1 + finNoVotes;
        w.tradedNoVotes = w.idleBefore;

        // Epoch 2: an idle token after the policy, never opened, only finalized.
        vm.warp(gov.epochStart(3));
        w.idleAfter = _finalize(2);
        assertEq(gov.winningCause(token, 2), DEFAULT_CAUSE);

        // Epoch 3: traded and voted, open + close + submitTally + finalize (ballots are voters' gas).
        uint256 open3 = _open(3);
        for (uint256 i; i < voters.length; ++i) {
            bytes32 handle = keccak256(abi.encode("in", i));
            executor.setInputValue(handle, uint8(i * 7));
            vm.prank(voters[i]);
            zama.castBallot(address(gov), token, 3, abi.encode(handle, hex"01"));
        }
        vm.warp(gov.epochStart(4));
        // The scheme's own requestTally of this poll with ballots, as the governor calls it.
        uint256 snap = vm.snapshotState();
        vm.startPrank(address(gov));
        w.mockRequestTally = _tx(address(zama), abi.encodeCall(zama.requestTally, (token, 3)))
            - _intrinsic(abi.encodeCall(zama.requestTally, (token, 3)));
        vm.stopPrank();
        vm.revertToState(snap);
        uint256 close3 = _tx(address(gov), abi.encodeCall(gov.closeEpoch, (token, 3)));
        bytes32[] memory words = zama.tallyHandles(address(gov), token, 3);
        bytes memory cleartexts;
        for (uint256 j; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        // A KMS proof of realistic size: a 1-byte count and three 65-byte signatures.
        bytes memory proof = abi.encodePacked(uint8(3), new bytes(195));
        uint256 submit3 = _tx(
            address(zama),
            abi.encodeCall(zama.submitTally, (address(gov), token, 3, cleartexts, proof))
        );
        uint256 fin3 = _finalize(3);
        w.voted = open3 + close3 + submit3 + fin3;

        // The scheme's own open on the mock coprocessor, called directly.
        vm.prank(owner);
        zama.setGovernor(address(this), true);
        w.mockOpen = _tx(address(zama), abi.encodeCall(zama.open, (token, 99, 32)))
            - _intrinsic(abi.encodeCall(zama.open, (token, 99, 32)));

        emit log_named_uint("open (prepareBallot, 32 options), tx gas", open1);
        emit log_named_uint("  of which scheme open (mock coprocessor)", w.mockOpen);
        emit log_named_uint(
            "  of which calldata + 21000",
            _intrinsic(
                abi.encodeCall(
                    gov.prepareBallot,
                    (token, 1, cat.draws(gov, registry, token, 1, uint64(1) << 2, 1))
                )
            )
        );
        emit log_named_uint("finalizeEpoch, opened without ballots, tx gas", finNoVotes);
        emit log_named_uint("finalizeEpoch, never opened, tx gas", w.idleAfter);
        emit log_named_uint("closeEpoch, tx gas", close3);
        emit log_named_uint("  of which scheme requestTally (mock coprocessor)", w.mockRequestTally);
        emit log_named_uint("submitTally (11 words), tx gas", submit3);
        emit log_named_uint("finalizeEpoch, voted, tx gas", fin3);
    }

    function _total(Weekly memory w, uint256 idle, uint256 noVotes, uint256 voted, bool afterPolicy)
        internal
        pure
        returns (uint256)
    {
        return idle * (afterPolicy ? w.idleAfter : w.idleBefore) + noVotes * w.tradedNoVotes + voted
            * w.voted;
    }

    function _logMix(
        Weekly memory w,
        string memory name,
        uint256 idle,
        uint256 noVotes,
        uint256 voted
    ) internal {
        uint256 b = _total(w, idle, noVotes, voted, false);
        uint256 a = _total(w, idle, noVotes, voted, true);
        emit log_string(name);
        emit log_named_uint("  weekly platform gas before", b);
        emit log_named_uint("  weekly platform gas after", a);
        emit log_named_uint("  saved (bps of before)", ((b - a) * 10_000) / b);
    }

    function test_gas_weeklyPlatformTotals_idlePolicy() public {
        Weekly memory w = _measure();

        emit log_named_uint("idle token-week before (open + finalize)", w.idleBefore);
        emit log_named_uint("idle token-week after (finalize only)", w.idleAfter);
        emit log_named_uint("traded, no votes, token-week (unchanged)", w.tradedNoVotes);
        emit log_named_uint("traded and voted, token-week (unchanged)", w.voted);

        // The policy only removes the idle token's open; everything else is the same transactions.
        assertLt(w.idleAfter, 100_000);
        assertGt(w.idleBefore, 10 * w.idleAfter);
        assertGt(w.voted, w.tradedNoVotes);

        // 1,000 registered tokens: a launchpad long tail, a middling week and a busy week.
        _logMix(w, "1000 tokens: 90% idle, 8% traded no votes, 2% voted", 900, 80, 20);
        _logMix(w, "1000 tokens: 70% idle, 25% traded no votes, 5% voted", 700, 250, 50);
        _logMix(w, "1000 tokens: 40% idle, 45% traded no votes, 15% voted", 400, 450, 150);

        Weekly memory l = _live(w);
        emit log_string("with the scheme's open and close at live mainnet coprocessor cost:");
        emit log_named_uint("idle token-week before", l.idleBefore);
        emit log_named_uint("idle token-week after", l.idleAfter);
        emit log_named_uint("traded, no votes, token-week", l.tradedNoVotes);
        emit log_named_uint("traded and voted, token-week", l.voted);
        _logMix(l, "1000 tokens: 90% idle, 8% traded no votes, 2% voted", 900, 80, 20);
        _logMix(l, "1000 tokens: 70% idle, 25% traded no votes, 5% voted", 700, 250, 50);
        _logMix(l, "1000 tokens: 40% idle, 45% traded no votes, 15% voted", 400, 450, 150);
    }
}
