// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVoteVerifier} from "../interfaces/IVoteVerifier.sol";

/// @title PublicSnapshotVerifier
/// @notice TEST-ONLY STUB. DO NOT DEPLOY TO PRODUCTION.
/// @dev Performs no authentication: the caller-supplied proof is `abi.encode(voter, weight)` and is
///      trusted as is, so anyone can claim any weight. It exists only to exercise `EpochGovernor`
///      in tests until a real (private) verifier implementing `IVoteVerifier` replaces it.
///      The vote reference is scoped to (token, epoch, voter) so a voter votes once per epoch.
contract PublicSnapshotVerifier is IVoteVerifier {
    /// @inheritdoc IVoteVerifier
    function verifyVote(address token, uint256 epoch, bytes32, bytes calldata proof)
        external
        pure
        returns (bool valid, uint256 weight, bytes32 voteRef)
    {
        if (proof.length != 64) return (false, 0, bytes32(0));
        address voter;
        (voter, weight) = abi.decode(proof, (address, uint256));
        valid = voter != address(0) && weight != 0;
        voteRef = keccak256(abi.encode(token, epoch, voter));
    }
}
