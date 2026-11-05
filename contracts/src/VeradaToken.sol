// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ERC20TimestampVotes} from "./ERC20TimestampVotes.sol";
import {IVeradaToken} from "./interfaces/IVeradaToken.sol";

/// @title VeradaToken
/// @notice Fixed-supply ERC20 with permit, burn and timestamp-based vote checkpoints. The whole
///         supply is minted once, at construction, to the account that deploys it (the factory).
/// @dev Every account is delegated to itself the first time it receives a non-zero amount, so
///      holders have voting power without a separate `delegate` transaction. An explicit
///      delegation is always kept: delegating to a non-zero account is never overridden, and
///      delegating to `address(0)` is an opt-out (`optedOut`) that incoming transfers never undo.
///      Any later explicit delegation to a non-zero account clears the opt-out.
contract VeradaToken is
    ERC20,
    ERC20Burnable,
    ERC20TimestampVotes,
    IERC20Permit,
    Nonces,
    IVeradaToken
{
    /// @notice Total supply minted at creation (100 billion, 18 decimals).
    uint256 public constant INITIAL_SUPPLY = 100_000_000_000e18;

    /// @inheritdoc IVeradaToken
    address public immutable creator;

    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant _DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");

    /// @notice Whether `account` explicitly delegated to `address(0)`, opting out of
    ///         auto-delegation. Cleared by a later delegation to a non-zero account.
    mapping(address account => bool) public optedOut;

    string private _metadataURI;
    bytes32 private immutable _nameHash;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    error ERC2612ExpiredSignature(uint256 deadline);
    error ERC2612InvalidSigner(address signer, address owner);

    /// @param name_ ERC20 name.
    /// @param symbol_ ERC20 symbol.
    /// @param metadataURI_ Token metadata URI, fixed for the life of the token.
    /// @param creator_ Account that launched the token.
    /// @param recipient Account receiving the whole supply.
    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address recipient
    ) ERC20(name_, symbol_) {
        _nameHash = keccak256(bytes(name_));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        creator = creator_;
        _metadataURI = metadataURI_;
        _mint(recipient, INITIAL_SUPPLY);
    }

    /// @inheritdoc IVeradaToken
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }

    /// @inheritdoc IVeradaToken
    function burn(uint256 amount) public override(ERC20Burnable, IVeradaToken) {
        super.burn(amount);
    }

    /// @inheritdoc IVeradaToken
    function burnFrom(address account, uint256 amount)
        public
        override(ERC20Burnable, IVeradaToken)
    {
        super.burnFrom(account, amount);
    }

    // ------------------------------------------------------------------ votes

    /// @inheritdoc IVotes
    function delegateBySig(
        address delegatee,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > expiry) revert VotesExpiredSignature(expiry);
        bytes32 structHash = keccak256(abi.encode(_DELEGATION_TYPEHASH, delegatee, nonce, expiry));
        address signer = ECDSA.recover(_hashTypedData(structHash), v, r, s);
        _useCheckedNonce(signer, nonce);
        _delegate(signer, delegatee);
    }

    /// @dev Self-delegates a recipient of a non-zero amount that never chose a delegate (and did
    ///      not opt out), then moves balance and votes. Zero-value transfers never delegate, so
    ///      nobody can change another account's delegation for free.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20TimestampVotes)
    {
        if (to != address(0) && value != 0 && delegates(to) == address(0) && !optedOut[to]) {
            _delegate(to, to);
        }
        super._update(from, to, value);
    }

    /// @dev Records an explicit opt-out (delegating to zero) and clears it on any other choice.
    ///      Every delegation path (`delegate`, `delegateBySig`, auto-delegation) goes through here.
    function _delegate(address account, address delegatee) internal override {
        optedOut[account] = delegatee == address(0);
        super._delegate(account, delegatee);
    }

    // ------------------------------------------------------------------ permit

    /// @inheritdoc IERC20Permit
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert ERC2612ExpiredSignature(deadline);

        bytes32 structHash = keccak256(
            abi.encode(_PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline)
        );
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(_hashTypedData(structHash), v, r, s);
        if (err != ECDSA.RecoverError.NoError || signer != owner) {
            revert ERC2612InvalidSigner(signer, owner);
        }
        _approve(owner, spender, value);
    }

    /// @inheritdoc IERC20Permit
    function nonces(address owner) public view override(IERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /// @inheritdoc IERC20Permit
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _nameHash, keccak256("1"), block.chainid, address(this))
        );
    }
}
