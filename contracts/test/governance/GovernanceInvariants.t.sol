// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "../utils/BallotLog.sol";
import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {TakeoverGovernor} from "../../src/TakeoverGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITakeoverGovernor} from "../../src/interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @dev Drives holders of a real VeradaToken through transfers, epoch ballots, takeover proposals
///      and the close/tally/finalize/execute steps, recording what the governors authorized.
contract GovernanceHandler is BallotLog {
    VeradaToken public token;
    MockVotingScheme public scheme;
    MockProfileRegistryLite public profiles;
    EpochGovernor public epochGov;
    TakeoverGovernor public takeover;

    address[] public voters;
    address public controllerA = makeAddr("controllerA");
    address public controllerB = makeAddr("controllerB");

    // Epoch bookkeeping.
    uint256[] public touchedEpochs;
    mapping(uint256 epoch => bool) public epochTouched;
    mapping(uint256 epoch => uint256) public epochAuthorizedWeight;
    mapping(uint256 epoch => uint256) public epochBallots;
    mapping(uint256 epoch => mapping(address voter => bool)) public epochVoted;

    // Takeover bookkeeping.
    uint256[] public proposals;
    mapping(uint256 proposalId => uint256) public proposalAuthorizedWeight;
    mapping(uint256 proposalId => uint256) public proposalBallots;
    mapping(uint256 proposalId => mapping(address voter => bool)) public proposalVoted;

    uint256 public epochBallotsAccepted;
    uint256 public takeoverBallotsAccepted;
    uint256 public proposalsAccepted;
    uint256 public executions;
    uint256 public lastExecutedId;

    constructor(
        VeradaToken token_,
        MockVotingScheme scheme_,
        MockProfileRegistryLite profiles_,
        EpochGovernor epochGov_,
        TakeoverGovernor takeover_,
        address[] memory voters_
    ) {
        _recordBallots();
        token = token_;
        scheme = scheme_;
        profiles = profiles_;
        epochGov = epochGov_;
        takeover = takeover_;
        voters = voters_;
    }

    function voterCount() external view returns (uint256) {
        return voters.length;
    }

    function touchedEpochCount() external view returns (uint256) {
        return touchedEpochs.length;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    // ---- actions

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(uint256(by), 1, 2 days));
    }

    function transfer(uint8 fromIdx, uint8 toIdx, uint128 amount) external {
        address from = voters[fromIdx % voters.length];
        address to = voters[toIdx % voters.length];
        uint256 value = bound(uint256(amount), 0, token.balanceOf(from));
        vm.prank(from);
        token.transfer(to, value);
        // Snapshots must be strictly in the past.
        vm.warp(block.timestamp + 1);
    }

    function voteEpoch(uint8 voterIdx, uint8 choice) external {
        address voter = voters[voterIdx % voters.length];
        uint256 epoch = epochGov.currentEpoch();
        uint64 weight = epochGov.weightOf(address(token), epoch, voter);
        bytes memory ballot = abi.encode(choice % 3);
        // Ballots need an opened epoch; anyone may open it.
        if (!epochGov.isPrepared(address(token), epoch)) {
            try epochGov.openEpoch(address(token), epoch) {} catch {}
        }
        vm.prank(voter);
        try scheme.castBallot(address(epochGov), address(token), epoch, ballot) {
            if (!epochTouched[epoch]) {
                epochTouched[epoch] = true;
                touchedEpochs.push(epoch);
            }
            epochAuthorizedWeight[epoch] += weight;
            epochBallots[epoch] += 1;
            epochVoted[epoch][voter] = true;
            epochBallotsAccepted += 1;
        } catch {}
    }

    function finalizeEndedEpochs() external {
        uint256 current = epochGov.currentEpoch();
        for (uint256 i; i < touchedEpochs.length; ++i) {
            uint256 epoch = touchedEpochs[i];
            if (epoch >= current || epochGov.isFinalized(address(token), epoch)) continue;
            if (!epochGov.isClosed(address(token), epoch)) {
                epochGov.closeEpoch(address(token), epoch);
            }
            (bool isFinal,) = scheme.tallyOf(address(epochGov), address(token), epoch);
            if (!isFinal) scheme.finalizeFromBallots(address(epochGov), address(token), epoch);
            epochGov.finalizeEpoch(
                address(token), epoch, _orgIds(address(epochGov), address(token), epoch)
            );
        }
    }

    function propose(uint8 voterIdx) external {
        address proposer = voters[voterIdx % voters.length];
        address current = profiles.controllerOf(address(token));
        address next = current == controllerA ? controllerB : controllerA;
        vm.prank(proposer);
        try takeover.propose(address(token), next) returns (uint256 id) {
            proposals.push(id);
            proposalsAccepted += 1;
        } catch {}
    }

    /// @dev One of the token's pending proposals (several may run at once), or zero.
    function _pickPending(uint8 pick) internal view returns (uint256) {
        uint256[] memory active = takeover.activeProposalsOf(address(token));
        if (active.length == 0) return 0;
        return active[pick % active.length];
    }

    function voteTakeover(uint8 voterIdx, bool voteFor, uint8 pick) external {
        uint256 id = _pickPending(pick);
        if (id == 0) return;
        address voter = voters[voterIdx % voters.length];
        uint64 weight = takeover.weightOf(id, voter);
        bytes memory ballot = abi.encode(voteFor ? takeover.FOR() : takeover.AGAINST());
        vm.prank(voter);
        try scheme.castBallot(address(takeover), address(token), id, ballot) {
            proposalAuthorizedWeight[id] += weight;
            proposalBallots[id] += 1;
            proposalVoted[id][voter] = true;
            takeoverBallotsAccepted += 1;
        } catch {}
    }

    function settleTakeover(uint8 pick) external {
        uint256 id = _pickPending(pick);
        if (id == 0) return;
        ITakeoverGovernor.State s = takeover.state(id);
        if (s == ITakeoverGovernor.State.Closing) {
            if (!takeover.isClosed(id)) takeover.closeProposal(id);
            (bool isFinal,) = scheme.tallyOf(address(takeover), address(token), id);
            if (!isFinal) scheme.finalizeFromBallots(address(takeover), address(token), id);
            takeover.recordTally(id);
            s = takeover.state(id);
        }
        if (s == ITakeoverGovernor.State.Succeeded) {
            takeover.execute(id);
            executions += 1;
            lastExecutedId = id;
        }
    }

    function cancelTakeover(uint8 who, uint8 pick) external {
        uint256 id = _pickPending(pick);
        if (id == 0) return;
        address caller = who % 2 == 0 ? takeover.getProposal(id).proposer : takeover.owner();
        vm.prank(caller);
        try takeover.cancel(id) {} catch {}
    }
}

contract GovernanceInvariants is Test {
    uint256 internal constant WEEK = 7 days;
    uint256 internal constant T0 = 1_750_000_123;

    VeradaToken internal token;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    CauseRegistry internal registry;
    EpochGovernor internal epochGov;
    TakeoverGovernor internal takeover;
    GovernanceHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address[] internal voters;
    bytes32[] internal causes;

    function setUp() public {
        vm.warp(T0);
        token = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", makeAddr("creator"), factory);
        // Six holders with 1% .. 6% of the supply each; the factory keeps the rest.
        for (uint256 i; i < 6; ++i) {
            address v = makeAddr(string(abi.encodePacked("voter", i)));
            voters.push(v);
            vm.prank(factory);
            token.transfer(v, (i + 1) * 1_000_000_000e18);
        }
        vm.warp(T0 + WEEK);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        // Three pinned causes fill every epoch ballot; takeover polls use two options.
        scheme.setMaxOptions(3);
        profiles = new MockProfileRegistryLite();
        CatalogFixture cat = new CatalogFixture();
        for (uint256 i; i < 3; ++i) {
            cat.add(cat.bucketOf(2, 0), keccak256(abi.encode("org", i)));
        }
        cat.publish();
        epochGov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            scheme,
            ITokenProfileRegistry(address(profiles))
        );
        takeover = new TakeoverGovernor(
            owner,
            ITokenProfileRegistry(address(profiles)),
            scheme,
            ITakeoverGovernor.Params({
                votingPeriod: 1 days,
                executionWindow: 2 days,
                cooldown: 0,
                minTokenAge: 0,
                quorumBps: 1000,
                proposalThresholdBps: 1,
                lookback: 1 days
            }),
            makeAddr("poolManager")
        );
        scheme.setGovernor(address(epochGov), true);
        scheme.setGovernor(address(takeover), true);
        profiles.setGovernor(address(takeover));

        handler = new GovernanceHandler(token, scheme, profiles, epochGov, takeover, voters);
        profiles.register(address(token), handler.controllerA());
        profiles.setFocus(address(token), uint64(1) << 2, uint16(1));

        vm.startPrank(owner);
        epochGov.setFactory(factory);
        registry.setMaterializer(address(epochGov), true);
        for (uint256 i; i < 3; ++i) {
            bytes32 orgId = keccak256(abi.encode("org", i));
            causes.push(keccak256(abi.encode(orgId)));
        }
        // The fallback cause is an owner-added registry cause; the others materialize on a win.
        bytes32 org0 = keccak256(abi.encode("org", uint256(0)));
        registry.addCause(causes[0], org0, orgFactory.computeOrgAddress(org0), "meta");
        epochGov.setDefaultCause(causes[0]);
        vm.stopPrank();
        vm.prank(factory);
        epochGov.registerToken(address(token));
        IEpochGovernor.Pin[] memory pins = new IEpochGovernor.Pin[](3);
        for (uint256 i; i < 3; ++i) {
            pins[i] = cat.pin(i);
        }
        vm.prank(handler.controllerA());
        epochGov.setShortlist(address(token), pins);

        targetContract(address(handler));
    }

    // ---- handler smoke test (the invariants must not hold vacuously)

    function test_handlerSmoke_exercisesEveryPath() public {
        handler.propose(0);
        assertEq(handler.proposalsAccepted(), 1);
        handler.propose(0); // the same proposer already has one pending: rejected
        assertEq(handler.proposalsAccepted(), 1);
        handler.voteTakeover(5, true, 0); // 6% FOR
        handler.voteTakeover(4, true, 0); // 5% FOR
        handler.voteTakeover(0, false, 0); // 1% AGAINST
        handler.voteTakeover(0, true, 0); // duplicate, rejected
        assertEq(handler.takeoverBallotsAccepted(), 3);
        // A concurrent proposal by another holder, superseded once the first executes.
        handler.propose(2);
        assertEq(handler.proposalsAccepted(), 2);
        assertEq(takeover.activeProposalsOf(address(token)).length, 2);

        handler.voteEpoch(1, 0);
        handler.voteEpoch(2, 1);
        handler.voteEpoch(2, 2); // duplicate, rejected
        handler.transfer(3, 1, type(uint128).max); // moves tokens, warps 1s
        handler.voteEpoch(3, 2); // weight is at the snapshot, still accepted
        assertEq(handler.epochBallotsAccepted(), 3);
        uint256 epoch = epochGov.currentEpoch();
        assertEq(handler.epochBallots(epoch), 3);
        assertEq(
            handler.epochAuthorizedWeight(epoch), 2_000_000_000 + 3_000_000_000 + 4_000_000_000
        );

        // Nothing settles before the windows end.
        handler.settleTakeover(0);
        handler.settleTakeover(1);
        handler.finalizeEndedEpochs();
        assertEq(handler.executions(), 0);
        assertFalse(epochGov.isFinalized(address(token), epoch));

        // Past the voting period: close, tally and execute the takeover (index 1: the oldest).
        vm.warp(block.timestamp + 1 days + 1);
        handler.settleTakeover(1);
        assertEq(handler.executions(), 1);
        assertEq(profiles.controllerOf(address(token)), handler.controllerB());
        assertEq(uint8(takeover.state(2)), uint8(ITakeoverGovernor.State.Superseded));
        assertEq(takeover.activeProposalsOf(address(token)).length, 0);

        // Past the epoch: close, publish the tally and finalize.
        vm.warp(epochGov.epochStart(epoch + 1));
        handler.finalizeEndedEpochs();
        assertTrue(epochGov.isFinalized(address(token), epoch));
        assertEq(epochGov.winningCause(address(token), epoch), causes[2]);

        // A new proposal can now be made and canceled by its proposer.
        handler.propose(1);
        assertEq(handler.proposalsAccepted(), 3);
        handler.cancelTakeover(0, 0);
        assertEq(uint8(takeover.state(3)), uint8(ITakeoverGovernor.State.Canceled));

        invariant_oneBallotPerVoterPerPoll();
        invariant_tallyMatchesAuthorizedWeight();
        invariant_atMostOnePendingProposalPerProposer();
        invariant_executionSupersedesOlderProposals();
        invariant_executionsReachRegistry();
        invariant_votesConserveSupply();
    }

    // ---- invariants

    /// One ballot per voter per poll, and the governor, scheme and handler agree on who voted.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_oneBallotPerVoterPerPoll() public view {
        uint256 n = handler.touchedEpochCount();
        for (uint256 i; i < n; ++i) {
            uint256 epoch = handler.touchedEpochs(i);
            uint256 counted;
            for (uint256 v; v < voters.length; ++v) {
                bool voted = handler.epochVoted(epoch, voters[v]);
                assertEq(epochGov.hasVoted(address(token), epoch, voters[v]), voted);
                assertEq(
                    scheme.hasVoted(address(epochGov), address(token), epoch, voters[v]), voted
                );
                if (voted) ++counted;
            }
            assertEq(counted, handler.epochBallots(epoch));
            assertEq(epochGov.voterCount(address(token), epoch), counted);
            assertEq(scheme.ballotCount(address(epochGov), address(token), epoch), counted);
        }

        uint256 m = handler.proposalCount();
        for (uint256 i; i < m; ++i) {
            uint256 id = handler.proposals(i);
            uint256 counted;
            for (uint256 v; v < voters.length; ++v) {
                bool voted = handler.proposalVoted(id, voters[v]);
                assertEq(takeover.hasVoted(id, voters[v]), voted);
                assertEq(scheme.hasVoted(address(takeover), address(token), id, voters[v]), voted);
                if (voted) ++counted;
            }
            assertEq(counted, handler.proposalBallots(id));
            assertEq(scheme.ballotCount(address(takeover), address(token), id), counted);
        }
    }

    /// Once finalized, the stored per-option counts sum to the weight the governor authorized.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_tallyMatchesAuthorizedWeight() public view {
        uint256 n = handler.touchedEpochCount();
        for (uint256 i; i < n; ++i) {
            uint256 epoch = handler.touchedEpochs(i);
            if (!epochGov.isFinalized(address(token), epoch)) continue;
            uint256 sum;
            for (uint256 c; c < causes.length; ++c) {
                sum += epochGov.tally(address(token), epoch, causes[c]);
            }
            assertEq(sum, handler.epochAuthorizedWeight(epoch));
            assertGt(sum, 0);
            // The winner holds the maximum count.
            uint256 winnerCount =
                epochGov.tally(address(token), epoch, epochGov.winningCause(address(token), epoch));
            for (uint256 c; c < causes.length; ++c) {
                assertGe(winnerCount, epochGov.tally(address(token), epoch, causes[c]));
            }
        }

        uint256 m = handler.proposalCount();
        for (uint256 i; i < m; ++i) {
            uint256 id = handler.proposals(i);
            ITakeoverGovernor.Proposal memory p = takeover.getProposal(id);
            if (!p.tallied) continue;
            assertEq(
                uint256(p.forWeight) + uint256(p.againstWeight),
                handler.proposalAuthorizedWeight(id)
            );
        }
    }

    /// Never more than one pending (active, closing or executable) proposal per (token, proposer),
    /// and the governor's pending views agree with the proposals' states.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_atMostOnePendingProposalPerProposer() public view {
        uint256 m = handler.proposalCount();
        uint256 pending;
        uint256 newest;
        for (uint256 v; v < voters.length; ++v) {
            uint256 mine;
            for (uint256 i; i < m; ++i) {
                uint256 id = handler.proposals(i);
                if (takeover.getProposal(id).proposer != voters[v]) continue;
                if (_isPending(takeover.state(id))) {
                    ++mine;
                    if (id > newest) newest = id;
                }
            }
            assertLe(mine, 1);
            pending += mine;
        }
        assertEq(takeover.activeProposalsOf(address(token)).length, pending);
        assertEq(takeover.activeProposalOf(address(token)), newest);
    }

    /// Once a proposal is executed, no proposal created before it is still pending.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_executionSupersedesOlderProposals() public view {
        uint256 last = handler.lastExecutedId();
        uint256 m = handler.proposalCount();
        for (uint256 i; i < m; ++i) {
            uint256 id = handler.proposals(i);
            if (id < last) assertFalse(_isPending(takeover.state(id)));
        }
    }

    function _isPending(ITakeoverGovernor.State s) internal pure returns (bool) {
        return s == ITakeoverGovernor.State.Active || s == ITakeoverGovernor.State.Closing
            || s == ITakeoverGovernor.State.Succeeded;
    }

    /// Executed takeovers always moved the controller through the registry.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_executionsReachRegistry() public view {
        assertEq(profiles.setControllerCalls(), handler.executions());
    }

    /// Vote checkpoints conserve the token supply.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    function invariant_votesConserveSupply() public view {
        uint256 sum = token.getVotes(factory);
        for (uint256 v; v < voters.length; ++v) {
            sum += token.getVotes(voters[v]);
        }
        assertEq(sum, token.totalSupply());
    }
}
