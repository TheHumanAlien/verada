// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

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
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @notice A 32-option catalogue ballot voted with encrypted choices on the real
///         `ZamaVotingScheme` (packed tallies), decrypted through the plaintext-shadowing mock
///         coprocessor, finalized and materialized.
contract CatalogZamaIntegrationTest is Test {
    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    ZamaVotingScheme internal zama;
    EpochGovernor internal gov;
    CauseRegistry internal registry;
    MockOrgFactory internal orgFactory;
    CatalogFixture internal cat;
    VeradaToken internal tokenContract;
    address internal token;
    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address[5] internal voters;

    function setUp() public {
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
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        zama = new ZamaVotingScheme(owner);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        cat = new CatalogFixture();
        for (uint256 i; i < 40; ++i) {
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
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        vm.warp(gov.epochStart(1));
    }

    function test_thirtyTwoOptionEncryptedBallot_endToEnd() public {
        assertEq(gov.ballotSize(), 32);
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, uint64(1) << 2, 1);
        gov.prepareBallot(token, 1, d);
        bytes32[] memory opts = gov.epochOptions(token, 1);
        assertEq(opts.length, 32);
        assertEq(zama.optionCountOf(address(gov), token, 1), 32);
        assertEq(zama.tallyHandles(address(gov), token, 1).length, 11);

        // Voters weigh 1M..5M whole tokens; options 31 (weights 1M + 4M) and 17 (5M) tie at 5M,
        // and 3 gets 2M + 3M = 5M as well. Ties go to the lowest index: option 3.
        uint8[5] memory choices = [31, 3, 3, 31, 17];
        for (uint256 i; i < voters.length; ++i) {
            bytes32 handle = keccak256(abi.encode("in", i));
            executor.setInputValue(handle, choices[i]);
            vm.prank(voters[i]);
            zama.castBallot(address(gov), token, 1, abi.encode(handle, hex"01"));
        }

        vm.warp(gov.epochStart(2));
        gov.closeEpoch(token, 1);
        bytes32[] memory words = zama.tallyHandles(address(gov), token, 1);
        bytes memory cleartexts;
        for (uint256 j; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        zama.submitTally(
            address(gov), token, 1, cleartexts, abi.encodePacked(uint8(1), new bytes(65))
        );
        gov.finalizeEpoch(token, 1);

        assertEq(gov.tally(token, 1, opts[31]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[3]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[17]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[0]), 0);
        assertEq(gov.winningCause(token, 1), opts[3]);
        assertTrue(registry.isActive(opts[3]));
        assertEq(
            registry.getCause(opts[3]).orgAddress,
            orgFactory.computeOrgAddress(gov.epochOptionOrgIds(token, 1)[3])
        );
    }

    function test_gas_castBallot_thirtyTwoOptions() public {
        gov.prepareBallot(token, 1, cat.draws(gov, registry, token, 1, uint64(1) << 2, 1));
        bytes32 handle = keccak256("in");
        executor.setInputValue(handle, 5);
        bytes memory ballot = abi.encode(handle, hex"01");
        vm.prank(voters[0]);
        uint256 before = gasleft();
        zama.castBallot(address(gov), token, 1, ballot);
        emit log_named_uint("castBallot gas, 32 options (mocked coprocessor)", before - gasleft());
    }
}
