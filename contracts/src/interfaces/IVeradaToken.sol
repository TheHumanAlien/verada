// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVeradaToken
/// @notice Fixed-supply ERC20 (with permit and burn) minted to the factory at creation.
interface IVeradaToken {
    /// @notice Account that launched the token. Immutable.
    function creator() external view returns (address);

    /// @notice URI pointing at the token metadata. Immutable.
    function metadataURI() external view returns (string memory);

    /// @notice Burns `amount` of the caller's tokens.
    function burn(uint256 amount) external;

    /// @notice Burns `amount` of `account`'s tokens using the caller's allowance.
    function burnFrom(address account, uint256 amount) external;
}
