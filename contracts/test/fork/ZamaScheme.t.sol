// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FheType} from "@fhevm/solidity/lib/FheType.sol";
import {CoprocessorConfig, IACL, IFHEVMExecutor} from "@fhevm/solidity/lib/Impl.sol";

import {FHE, euint8} from "@fhevm/solidity/lib/FHE.sol";

import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {IBallotGovernor} from "../../src/interfaces/IVotingScheme.sol";
import {ColdGas} from "../utils/ColdGas.sol";
import {EagerTallyScheme} from "../utils/EagerTallyScheme.sol";

/// @notice Mainnet fork test against the live Zama coprocessor, ACL and KMS verifier. The first
///         ballot of a poll creates its encrypted tally words (real symbolic FHE operations and ACL
///         grants); closing it marks them publicly decryptable. Skipped unless `ETH_RPC_URL` is set.
/// @dev `castBallot` itself is not exercised here: a valid input proof needs the relayer SDK, which
///      the publisher's live script covers. `ZamaSchemeHarness` runs the same per-ballot
///      accumulation on a trivially encrypted choice instead, so the live coprocessor's HCU
///      accounting and per-transaction limits apply to exactly the operations a ballot performs.
contract ZamaSchemeForkTest is ColdGas, IBallotGovernor {
    uint256 internal constant SCOPE = 1;

    ZamaVotingScheme internal scheme;
    IFHEVMExecutor internal executor;
    IACL internal acl;
    address internal token = makeAddr("token");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 1, "not mainnet");

        // Zama protocol contracts on Ethereum mainnet, as shipped in @fhevm/solidity's ZamaConfig.
        CoprocessorConfig memory cfg = ZamaConfig.getEthereumCoprocessorConfig();
        assertEq(cfg.ACLAddress, 0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6);
        assertEq(cfg.CoprocessorAddress, 0xD82385dADa1ae3E969447f20A3164F6213100e75);
        assertEq(cfg.KMSVerifierAddress, 0x77627828a55156b04Ac0DC0eb30467f1a552BB03);
        assertGt(cfg.ACLAddress.code.length, 0, "no ACL");
        assertGt(cfg.CoprocessorAddress.code.length, 0, "no coprocessor");
        assertGt(cfg.KMSVerifierAddress.code.length, 0, "no KMS verifier");
        executor = IFHEVMExecutor(cfg.CoprocessorAddress);
        acl = IACL(cfg.ACLAddress);

        scheme = new ZamaVotingScheme(address(this));
        scheme.setGovernor(address(this), true);
    }

    /// @inheritdoc IBallotGovernor
    function authorizeBallot(address, uint256, address, bytes32) external pure returns (uint64) {
        return 1;
    }

    function test_fork_openThenRequestTally() public {
        ZamaSchemeHarness h = new ZamaSchemeHarness(address(this));
        h.setGovernor(address(this), true);
        scheme = h;
        scheme.open(token, SCOPE, 5);
        assertTrue(scheme.isOpen(address(this), token, SCOPE));
        assertEq(scheme.optionCountOf(address(this), token, SCOPE), 5);
        // Lazy tallies: no word until the first ballot.
        assertEq(scheme.tallyHandles(address(this), token, SCOPE).length, 0);
        h.castTrivial(address(this), token, SCOPE, 3);

        // Five options pack into two tally words.
        bytes32[] memory handles = scheme.tallyHandles(address(this), token, SCOPE);
        assertEq(handles.length, 2);
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(handles[i] != bytes32(0), "zero handle");
            // The live executor decodes the handle layout; reverts unless it is an euint128.
            executor.checkHandleType(handles[i], FheType.Uint128);
            assertTrue(acl.isAllowed(handles[i], address(scheme)), "scheme not allowed");
            assertTrue(acl.persistAllowed(handles[i], address(scheme)), "allowThis missing");
            assertFalse(acl.isAllowedForDecryption(handles[i]), "decryptable too early");
        }
        vm.expectRevert();
        executor.checkHandleType(handles[0], FheType.Uint8);

        scheme.requestTally(token, SCOPE);
        assertTrue(scheme.isClosed(address(this), token, SCOPE));
        assertFalse(scheme.isOpen(address(this), token, SCOPE));
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(acl.isAllowedForDecryption(handles[i]), "not publicly decryptable");
        }
    }

    /// @notice A poll closed without ballots is final with zero counts on the live contracts,
    ///         without any FHE operation or public decryption.
    function test_fork_requestTallyWithoutBallots() public {
        scheme.open(token, SCOPE, 32);
        uint256 g = gasleft();
        scheme.requestTally(token, SCOPE);
        emit log_named_uint("requestTally gas, 32 options, no ballots (lazy)", g - gasleft());
        (bool isFinal, uint64[] memory counts) = scheme.tallyOf(address(this), token, SCOPE);
        assertTrue(isFinal);
        assertEq(counts.length, 32);
        assertEq(scheme.tallyHandles(address(this), token, SCOPE).length, 0);
    }

    /// @notice Before/after of the tally setup on the live coprocessor at each ballot size: what
    ///         `open` cost when it created the encrypted zero words (eager, replayed with
    ///         `preallocate`) and what it costs now, plus the first and second ballot in each mode.
    ///         Each mode runs from the same fork state and every step starts from cold accounts, as
    ///         its own transaction would (see `ColdGas` for the residual undercount).
    function test_fork_lazyVsEagerTallyCost() public {
        ZamaSchemeHarness h = new ZamaSchemeHarness(address(this));
        h.setGovernor(address(this), true);
        uint8[3] memory sizes = [2, 10, 32];
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < sizes.length; ++i) {
            uint256[2] memory openGas;
            uint256[2] memory firstGas;
            uint256[2] memory secondGas;
            for (uint256 m; m < 2; ++m) {
                vm.revertToState(snap);
                _startCold();
                _cool();
                uint256 scope = 300 + i;
                uint256 g = gasleft();
                h.open(token, scope, sizes[i]);
                if (m == 0) h.preallocate(address(this), token, scope);
                openGas[m] = g - gasleft();
                _cool();
                g = gasleft();
                h.castTrivialAs(address(this), token, scope, sizes[i] - 1, address(1));
                firstGas[m] = g - gasleft();
                _cool();
                g = gasleft();
                h.castTrivialAs(address(this), token, scope, 0, address(2));
                secondGas[m] = g - gasleft();
                _stopCold();
                assertEq(h.tallyHandles(address(this), token, scope).length, h.wordCount(sizes[i]));
            }
            emit log_named_uint("options", sizes[i]);
            emit log_named_uint("  open gas, before (eager, live coprocessor)", openGas[0]);
            emit log_named_uint("  open gas, after (lazy)", openGas[1]);
            emit log_named_uint("  first ballot gas, before", firstGas[0]);
            emit log_named_uint("  first ballot gas, after", firstGas[1]);
            emit log_named_uint("  second ballot gas, before", secondGas[0]);
            emit log_named_uint("  second ballot gas, after", secondGas[1]);
            assertLt(openGas[1], openGas[0]);
            // Every word still costs the same FHE operations; the first voter pays at most one
            // fresh slot per word (plus the array length) over the eager first ballot.
            assertLt(firstGas[1], firstGas[0] + (h.wordCount(sizes[i]) + 1) * 22_100);
            assertApproxEqRel(secondGas[1], secondGas[0], 0.02e18);
        }
    }

    /// @dev One ballot's worth of FHE operations at each ballot size, on the live coprocessor.
    ///      Reverts if a ballot would exceed Zama's per-transaction HCU limits.
    /// @notice Gas of a whole ballot on the live mainnet contracts, input-proof verification
    ///         excluded (a trivially encrypted choice stands in for `FHE.fromExternal`).
    function test_fork_castBallotCost() public {
        ZamaSchemeHarness h = new ZamaSchemeHarness(address(this));
        h.setGovernor(address(this), true);
        uint8[3] memory sizes = [2, 10, 32];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 scope = 200 + i;
            h.open(token, scope, sizes[i]);
            uint256 before = gasleft();
            h.castTrivial(address(this), token, scope, sizes[i] - 1);
            uint256 used = before - gasleft();
            emit log_named_uint("options", sizes[i]);
            emit log_named_uint(
                "first castBallot gas (creates the tally words), input proof excluded", used
            );
            assertEq(h.ballotCount(address(this), token, scope), 1);
            assertTrue(h.hasVoted(address(this), token, scope, address(this)));
        }
    }

    /// @dev Steady-state accumulation (into existing words) of one ballot at each ballot size.
    function test_fork_ballotCost() public {
        ZamaSchemeHarness h = new ZamaSchemeHarness(address(this));
        h.setGovernor(address(this), true);
        uint8[4] memory sizes = [2, 10, 24, 32];
        for (uint256 i; i < sizes.length; ++i) {
            h.open(token, 100 + i, sizes[i]);
            h.preallocate(address(this), token, 100 + i);
            uint256 before = gasleft();
            h.accumulateTrivial(address(this), token, 100 + i, sizes[i] - 1, 1_000_000);
            emit log_named_uint("options", sizes[i]);
            emit log_named_uint("ballot accumulation gas (live coprocessor)", before - gasleft());
        }
    }
}

/// @dev Exposes the scheme's per-ballot accumulation on a trivially encrypted choice.
contract ZamaSchemeHarness is EagerTallyScheme {
    constructor(address owner_) EagerTallyScheme(owner_) {}

    function accumulateTrivial(
        address governor,
        address token,
        uint256 scope,
        uint8 choice,
        uint64 weight
    ) external {
        euint8 c = FHE.asEuint8(choice);
        _accumulate(_pollOf(governor, token, scope), c, weight);
    }

    /// @dev `castBallot` with the input proof replaced by a trivial encryption of `choice`:
    ///      everything a real ballot does on the live contracts (governor callback, poll
    ///      bookkeeping, FHE accumulation, event) except `InputVerifier.verifyCiphertext`.
    function castTrivial(address governor, address token, uint256 scope, uint8 choice)
        external
        returns (bytes32 ballotRef)
    {
        return castTrivialAs(governor, token, scope, choice, msg.sender);
    }

    /// @dev `castTrivial` on behalf of `voter`, so one test contract can cast several ballots.
    function castTrivialAs(
        address governor,
        address token,
        uint256 scope,
        uint8 choice,
        address voter
    ) public returns (bytes32 ballotRef) {
        if (!isGovernor[governor]) revert NotGovernor(governor);
        ballotRef = keccak256(abi.encode(governor, token, scope, voter, bytes32(uint256(choice))));
        uint64 weight = IBallotGovernor(governor).authorizeBallot(token, scope, voter, ballotRef);
        Poll storage poll = _pollOf(governor, token, scope);
        if (!poll.opened) revert PollNotOpen(governor, token, scope);
        if (poll.closed) revert PollClosed(governor, token, scope);
        if (weight == 0) revert ZeroWeight();
        if (weight > MAX_WEIGHT) revert WeightTooLarge(weight);
        if (poll.voted[voter]) revert AlreadyVoted(voter);
        poll.voted[voter] = true;
        ++poll.ballotCount;
        _accumulate(poll, FHE.asEuint8(choice), weight);
        emit BallotCast(governor, token, scope, voter, weight, ballotRef);
    }
}
