// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {VeradaToken} from "../src/VeradaToken.sol";

contract VeradaTokenTest is Test {
    VeradaToken internal token;
    address internal creator = makeAddr("creator");
    address internal factory = makeAddr("factory");

    function setUp() public {
        token = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
    }

    function test_metadataAndSupply() public view {
        assertEq(token.name(), "Verada Test");
        assertEq(token.symbol(), "VTEST");
        assertEq(token.decimals(), 18);
        assertEq(token.creator(), creator);
        assertEq(token.metadataURI(), "ipfs://meta");
        assertEq(token.totalSupply(), 100_000_000_000e18);
        assertEq(token.balanceOf(factory), 100_000_000_000e18);
    }

    function testFuzz_burnReducesSupply(uint256 amount) public {
        amount = bound(amount, 0, token.INITIAL_SUPPLY());
        vm.prank(factory);
        token.burn(amount);
        assertEq(token.totalSupply(), token.INITIAL_SUPPLY() - amount);
        assertEq(token.balanceOf(factory), token.INITIAL_SUPPLY() - amount);
    }

    function test_burnFromUsesAllowance() public {
        address spender = makeAddr("spender");
        vm.prank(factory);
        token.approve(spender, 10e18);
        vm.prank(spender);
        token.burnFrom(factory, 4e18);
        assertEq(token.allowance(factory, spender), 6e18);
        assertEq(token.totalSupply(), token.INITIAL_SUPPLY() - 4e18);
    }

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
        uint256 deadline = 1000;
        bytes32 digest = _permitDigest(owner, address(1), 1, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.warp(1001);
        vm.expectRevert(
            abi.encodeWithSelector(VeradaToken.ERC2612ExpiredSignature.selector, deadline)
        );
        token.permit(owner, address(1), 1, deadline, v, r, s);
    }

    function test_permitWrongSignerReverts() public {
        (, uint256 pk) = makeAddrAndKey("other");
        address owner = makeAddr("owner");
        uint256 deadline = block.timestamp + 1;
        bytes32 digest = _permitDigest(owner, address(1), 1, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert();
        token.permit(owner, address(1), 1, deadline, v, r, s);
    }

    function test_domainSeparatorTracksChainId() public {
        bytes32 before_ = token.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(token.DOMAIN_SEPARATOR() != before_);
    }

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
}
