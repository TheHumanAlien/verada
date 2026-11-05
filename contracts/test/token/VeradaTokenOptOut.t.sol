// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {VeradaToken} from "../../src/VeradaToken.sol";

/// @notice An explicit delegate(address(0)) opt-out survives every incoming transfer, whoever
///         sends it and whatever the amount (zero included), through transfer and transferFrom.
contract VeradaTokenOptOutTest is Test {
    VeradaToken internal token;
    address internal factory = makeAddr("factory");
    address internal holder = makeAddr("holder");

    function setUp() public {
        vm.warp(1_750_000_000);
        token = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", makeAddr("creator"), factory);
        vm.prank(factory);
        token.transfer(holder, 1000e18);
        vm.prank(holder);
        token.delegate(address(0));
    }

    function testFuzz_optOutSurvivesAnyIncomingTransfer(address sender, uint96 amount, bool viaFrom)
        public
    {
        vm.assume(sender != address(0) && sender != holder && sender != factory);
        if (amount != 0) {
            vm.prank(factory);
            token.transfer(sender, amount);
        }

        if (viaFrom) {
            // A third party pulls the sender's tokens to the holder (zero needs no allowance).
            address spender = makeAddr("spender");
            vm.prank(sender);
            token.approve(spender, amount);
            vm.prank(spender);
            token.transferFrom(sender, holder, amount);
        } else {
            vm.prank(sender);
            token.transfer(holder, amount);
        }

        assertTrue(token.optedOut(holder));
        assertEq(token.delegates(holder), address(0));
        assertEq(token.getVotes(holder), 0);
        assertEq(token.balanceOf(holder), 1000e18 + uint256(amount));
    }
}
