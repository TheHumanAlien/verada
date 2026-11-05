// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVoteVerifier
/// @notice Pluggable verifier deciding whether a vote is valid, allowing private schemes.
interface IVoteVerifier {
    /// @notice Verifies a vote and returns its weight and an opaque reference.
    /// @param token The token being voted on.
    /// @param epoch The epoch of the vote.
    /// @param causeId The chosen cause.
    /// @param proof Scheme-specific proof or payload.
    /// @return valid Whether the vote is valid.
    /// @return weight Voting weight granted.
    /// @return voteRef Opaque reference (e.g. nullifier) preventing double votes.
    function verifyVote(address token, uint256 epoch, bytes32 causeId, bytes calldata proof)
        external
        returns (bool valid, uint256 weight, bytes32 voteRef);
}
