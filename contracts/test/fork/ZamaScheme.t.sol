// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FheType} from "@fhevm/solidity/lib/FheType.sol";
import {CoprocessorConfig, IACL, IFHEVMExecutor} from "@fhevm/solidity/lib/Impl.sol";
import {Test} from "forge-std/Test.sol";

import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {IBallotGovernor} from "../../src/interfaces/IVotingScheme.sol";

/// @notice Mainnet fork test against the live Zama coprocessor, ACL and KMS verifier. Opening a
///         poll runs real symbolic FHE operations (trivial encryptions) and ACL grants; closing it
///         marks the tallies publicly decryptable. Skipped unless `ETH_RPC_URL` is set.
/// @dev `castBallot` is not exercised here: a valid input proof needs the relayer SDK, which the
///      publisher's live script covers.
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
        scheme.open(token, SCOPE, 3);
        assertTrue(scheme.isOpen(address(this), token, SCOPE));
        assertEq(scheme.optionCountOf(address(this), token, SCOPE), 3);

        bytes32[] memory handles = scheme.tallyHandles(address(this), token, SCOPE);
        assertEq(handles.length, 3);
        for (uint256 i = 0; i < handles.length; ++i) {
            assertTrue(handles[i] != bytes32(0), "zero handle");
            // The live executor decodes the handle layout; reverts unless it is an euint64.
            executor.checkHandleType(handles[i], FheType.Uint64);
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
}
