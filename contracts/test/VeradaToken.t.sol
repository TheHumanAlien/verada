// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Test} from "forge-std/Test.sol";

import {ERC20TimestampVotes} from "../src/ERC20TimestampVotes.sol";
import {VeradaToken} from "../src/VeradaToken.sol";

contract VeradaTokenTest is Test {
    uint256 internal constant SUPPLY = 100_000_000_000e18;
    uint256 internal constant T0 = 1_750_000_000;

    VeradaToken internal token;
    address internal creator = makeAddr("creator");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(T0);
        token = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        token.transfer(to, amount);
    }

    // ---- ERC20 / metadata

    function test_metadataAndSupply() public view {
        assertEq(token.name(), "Verada Test");
        assertEq(token.symbol(), "VTEST");
        assertEq(token.decimals(), 18);
        assertEq(token.creator(), creator);
        assertEq(token.metadataURI(), "ipfs://meta");
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.INITIAL_SUPPLY(), SUPPLY);
        assertEq(token.balanceOf(factory), SUPPLY);
    }

    function testFuzz_burnReducesSupply(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);
        vm.prank(factory);
        token.burn(amount);
        assertEq(token.totalSupply(), SUPPLY - amount);
        assertEq(token.balanceOf(factory), SUPPLY - amount);
    }

    function test_burnFromUsesAllowance() public {
        address spender = makeAddr("spender");
        vm.prank(factory);
        token.approve(spender, 10e18);
        vm.prank(spender);
        token.burnFrom(factory, 4e18);
        assertEq(token.allowance(factory, spender), 6e18);
        assertEq(token.totalSupply(), SUPPLY - 4e18);
    }

    // ---- votes: clock

    function test_clockIsTimestamp() public {
        assertEq(token.clock(), uint48(T0));
        assertEq(token.CLOCK_MODE(), "mode=timestamp");
        vm.warp(T0 + 123);
        assertEq(token.clock(), uint48(T0 + 123));
    }

    // ---- votes: auto-delegation

    function test_mintAutoDelegatesRecipient() public view {
        assertEq(token.delegates(factory), factory);
        assertEq(token.getVotes(factory), SUPPLY);
        assertEq(token.numCheckpoints(factory), 1);
        ERC20TimestampVotes.Checkpoint memory cp = token.checkpoints(factory, 0);
        assertEq(cp.key, uint48(T0));
        assertEq(cp.value, uint208(SUPPLY));
    }

    function test_transferMovesVotes_andAutoDelegatesFreshRecipient() public {
        assertEq(token.delegates(alice), address(0));
        vm.expectEmit(true, true, true, true);
        emit IVotes.DelegateChanged(alice, address(0), alice);
        _give(alice, 1000e18);
        assertEq(token.delegates(alice), alice);
        assertEq(token.getVotes(alice), 1000e18);
        assertEq(token.getVotes(factory), SUPPLY - 1000e18);

        vm.prank(alice);
        token.transfer(bob, 400e18);
        assertEq(token.delegates(bob), bob);
        assertEq(token.getVotes(alice), 600e18);
        assertEq(token.getVotes(bob), 400e18);
    }

    function test_explicitDelegationIsRespected() public {
        _give(alice, 1000e18);
        vm.prank(alice);
        token.delegate(bob);
        assertEq(token.delegates(alice), bob);
        assertEq(token.getVotes(alice), 0);
        assertEq(token.getVotes(bob), 1000e18);

        // Receiving more tokens must not re-delegate alice to herself.
        _give(alice, 500e18);
        assertEq(token.delegates(alice), bob);
        assertEq(token.getVotes(alice), 0);
        assertEq(token.getVotes(bob), 1500e18);

        // Sending tokens away debits the chosen delegate.
        vm.prank(alice);
        token.transfer(makeAddr("carol"), 300e18);
        assertEq(token.getVotes(bob), 1200e18);
    }

    /// L-2: an explicit opt-out survives incoming transfers.
    function test_delegateToZero_optOutSurvivesTransfers() public {
        _give(alice, 10e18);
        assertFalse(token.optedOut(alice));
        vm.prank(alice);
        token.delegate(address(0));
        assertTrue(token.optedOut(alice));
        assertEq(token.getVotes(alice), 0);
        _give(alice, 1e18);
        assertEq(token.delegates(alice), address(0));
        assertEq(token.getVotes(alice), 0);
        assertEq(token.balanceOf(alice), 11e18);

        // A later explicit delegation clears the opt-out.
        vm.prank(alice);
        token.delegate(alice);
        assertFalse(token.optedOut(alice));
        assertEq(token.getVotes(alice), 11e18);
    }

    /// L-2 (ported PoC): a zero-value transfer can no longer re-delegate an opted-out holder.
    function test_zeroValueTransfer_doesNotReDelegate() public {
        _give(alice, 1000e18);
        vm.prank(alice);
        token.delegate(address(0));
        vm.prank(bob);
        token.transfer(alice, 0);
        assertEq(token.delegates(alice), address(0));
        assertEq(token.getVotes(alice), 0);
    }

    /// L-2: zero-value transfers never auto-delegate, even a fresh account.
    function test_zeroValueTransfer_doesNotDelegateFreshAccount() public {
        address carol = makeAddr("carol");
        vm.prank(bob);
        token.transfer(carol, 0);
        assertEq(token.delegates(carol), address(0));
        assertFalse(token.optedOut(carol));
        _give(carol, 1e18);
        assertEq(token.delegates(carol), carol);
    }

    function test_delegateBySigToZero_optsOut() public {
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        _give(signer, 7e18);
        uint256 expiry = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _delegationDigest(address(0), 0, expiry));
        token.delegateBySig(address(0), 0, expiry, v, r, s);
        assertTrue(token.optedOut(signer));
        _give(signer, 1e18);
        assertEq(token.delegates(signer), address(0));
        assertEq(token.getVotes(signer), 0);
    }

    // ---- votes: history

    function test_getPastVotes_readsHistory() public {
        _give(alice, 100e18);
        vm.warp(T0 + 10);
        _give(alice, 50e18);
        vm.warp(T0 + 20);
        vm.prank(alice);
        token.transfer(bob, 30e18);
        vm.warp(T0 + 30);

        assertEq(token.getPastVotes(alice, T0 - 1), 0);
        assertEq(token.getPastVotes(alice, T0), 100e18);
        assertEq(token.getPastVotes(alice, T0 + 9), 100e18);
        assertEq(token.getPastVotes(alice, T0 + 10), 150e18);
        assertEq(token.getPastVotes(alice, T0 + 20), 120e18);
        assertEq(token.getPastVotes(alice, T0 + 29), 120e18);
        assertEq(token.getPastVotes(bob, T0 + 19), 0);
        assertEq(token.getPastVotes(bob, T0 + 20), 30e18);
        assertEq(token.getPastVotes(factory, T0 + 29), SUPPLY - 150e18);
        assertEq(token.getPastTotalSupply(T0 + 29), SUPPLY);
        assertEq(token.getPastTotalSupply(T0 - 1), 0);
        assertEq(token.numCheckpoints(alice), 3);
    }

    function test_getPastVotes_currentTimestampReverts() public {
        _give(alice, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20TimestampVotes.ERC5805FutureLookup.selector, T0, uint48(T0))
        );
        token.getPastVotes(alice, T0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20TimestampVotes.ERC5805FutureLookup.selector, T0 + 5, uint48(T0)
            )
        );
        token.getPastTotalSupply(T0 + 5);
        // One second later the former "now" becomes readable.
        vm.warp(T0 + 1);
        assertEq(token.getPastVotes(alice, T0), 1e18);
    }

    function test_sameSecondUpdatesOverwriteCheckpoint() public {
        _give(alice, 1e18);
        _give(alice, 2e18);
        assertEq(token.numCheckpoints(alice), 1);
        assertEq(token.getVotes(alice), 3e18);
        vm.warp(T0 + 1);
        _give(alice, 1e18);
        assertEq(token.numCheckpoints(alice), 2);
        assertEq(token.getPastVotes(alice, T0), 3e18);
    }

    function test_burnReducesVotesAndSupplyHistory() public {
        _give(alice, 100e18);
        vm.warp(T0 + 1);
        vm.prank(alice);
        token.burn(40e18);
        assertEq(token.getVotes(alice), 60e18);
        vm.warp(T0 + 2);
        assertEq(token.getPastVotes(alice, T0), 100e18);
        assertEq(token.getPastVotes(alice, T0 + 1), 60e18);
        assertEq(token.getPastTotalSupply(T0), SUPPLY);
        assertEq(token.getPastTotalSupply(T0 + 1), SUPPLY - 40e18);
    }

    function testFuzz_votesConserveSupply(uint8[6] calldata picks, uint64[6] calldata amounts)
        public
    {
        address[4] memory holders = [factory, alice, bob, makeAddr("carol")];
        for (uint256 i; i < 6; ++i) {
            address from = holders[picks[i] % 4];
            address to = holders[(picks[i] / 4) % 4];
            uint256 amount = bound(uint256(amounts[i]), 0, token.balanceOf(from));
            vm.prank(from);
            token.transfer(to, amount);
            vm.warp(block.timestamp + 1);
        }
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            assertEq(token.getVotes(holders[i]), token.balanceOf(holders[i]));
            sum += token.getVotes(holders[i]);
        }
        assertEq(sum, SUPPLY);
        assertEq(token.getPastTotalSupply(block.timestamp - 1), SUPPLY);
    }

    function test_gas_transferBetweenDelegatedHolders() public {
        _give(alice, 1000e18);
        _give(bob, 1000e18);
        vm.warp(T0 + 1);
        vm.prank(alice);
        uint256 before = gasleft();
        token.transfer(bob, 1e18);
        emit log_named_uint("gas: transfer between delegated holders", before - gasleft());
    }

    // ---- delegateBySig

    function test_delegateBySig() public {
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        _give(signer, 7e18);
        uint256 expiry = block.timestamp + 1 hours;
        bytes32 digest = _delegationDigest(bob, 0, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.delegateBySig(bob, 0, expiry, v, r, s);
        assertEq(token.delegates(signer), bob);
        assertEq(token.getVotes(bob), 7e18);
        assertEq(token.getVotes(signer), 0);
        assertEq(token.nonces(signer), 1);

        // Replay fails on the nonce.
        vm.expectRevert(
            abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, signer, uint256(1))
        );
        token.delegateBySig(bob, 0, expiry, v, r, s);
    }

    function test_delegateBySig_expiredReverts() public {
        (, uint256 pk) = makeAddrAndKey("signer");
        uint256 expiry = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _delegationDigest(bob, 0, expiry));
        vm.expectRevert(abi.encodeWithSelector(IVotes.VotesExpiredSignature.selector, expiry));
        token.delegateBySig(bob, 0, expiry, v, r, s);
    }

    // ---- permit

    function test_permit() public {
        (address owner, uint256 pk) = makeAddrAndKey("owner");
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = _permitDigest(owner, spender, 5e18, token.nonces(owner), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(owner, spender, 5e18, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), 5e18);
        assertEq(token.nonces(owner), 1);

        vm.expectRevert();
        token.permit(owner, spender, 5e18, deadline, v, r, s);
    }

    function test_permitExpiredReverts() public {
        (address owner, uint256 pk) = makeAddrAndKey("owner");
        uint256 deadline = block.timestamp - 1;
        bytes32 digest = _permitDigest(owner, address(1), 1, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(
            abi.encodeWithSelector(VeradaToken.ERC2612ExpiredSignature.selector, deadline)
        );
        token.permit(owner, address(1), 1, deadline, v, r, s);
    }

    function test_permitWrongSignerReverts() public {
        (address other, uint256 pk) = makeAddrAndKey("other");
        address owner = makeAddr("owner");
        uint256 deadline = block.timestamp + 1;
        bytes32 digest = _permitDigest(owner, address(1), 1, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(
            abi.encodeWithSelector(VeradaToken.ERC2612InvalidSigner.selector, other, owner)
        );
        token.permit(owner, address(1), 1, deadline, v, r, s);
    }

    function test_domainSeparatorTracksChainId() public {
        bytes32 before_ = token.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(token.DOMAIN_SEPARATOR() != before_);
    }

    // ---- helpers

    function _permitDigest(
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _delegationDigest(address delegatee, uint256 nonce, uint256 expiry)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"),
                delegatee,
                nonce,
                expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }
}
