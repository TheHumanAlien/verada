// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal view of an Endaoment org entity.
interface IEndaomentOrg {
    /// @notice Pulls `amount` of the base token (USDC) from the caller; allowance spender is the org.
    function donate(uint256 amount) external;

    function orgId() external view returns (bytes32);

    function baseToken() external view returns (address);
}
