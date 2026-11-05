// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FheType} from "@fhevm/solidity/lib/FheType.sol";
import {CoprocessorConfig, IACL, IFHEVMExecutor} from "@fhevm/solidity/lib/Impl.sol";
import {Test} from "forge-std/Test.sol";

import {FHE, euint8} from "@fhevm/solidity/lib/FHE.sol";

import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {IBallotGovernor} from "../../src/interfaces/IVotingScheme.sol";

/// @notice Mainnet fork test against the live Zama coprocessor, ACL and KMS verifier. Opening a
///         poll runs real symbolic FHE operations (trivial encryptions) and ACL grants; closing it
///         marks the tallies publicly decryptable. Skipped unless `ETH_RPC_URL` is set.
/// @dev `castBallot` itself is not exercised here: a valid input proof needs the relayer SDK, which
///      the publisher's live script covers. `ZamaSchemeHarness` runs the same per-ballot
///      accumulation on a trivially encrypted choice instead, so the live coprocessor's HCU
///      accounting and per-transaction limits apply to exactly the operations a ballot performs.
contract ZamaSchemeForkTest is Test, IBallotGovernor {
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
        scheme.open(token, SCOPE, 5);
        assertTrue(scheme.isOpen(address(this), token, SCOPE));
        assertEq(scheme.optionCountOf(address(this), token, SCOPE), 5);

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

    /// @dev One ballot's worth of FHE operations at each ballot size, on the live coprocessor.
    ///      Reverts if a ballot would exceed Zama's per-transaction HCU limits.
    function test_fork_ballotCost() public {
        ZamaSchemeHarness h = new ZamaSchemeHarness(address(this));
        h.setGovernor(address(this), true);
        uint8[4] memory sizes = [2, 10, 24, 32];
        for (uint256 i; i < sizes.length; ++i) {
            h.open(token, 100 + i, sizes[i]);
            uint256 before = gasleft();
            h.accumulateTrivial(address(this), token, 100 + i, sizes[i] - 1, 1_000_000);
            emit log_named_uint("options", sizes[i]);
            emit log_named_uint("ballot accumulation gas (live coprocessor)", before - gasleft());
        }
    }
}

/// @dev Exposes the scheme's per-ballot accumulation on a trivially encrypted choice.
contract ZamaSchemeHarness is ZamaVotingScheme {
    constructor(address owner_) ZamaVotingScheme(owner_) {}

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
}
