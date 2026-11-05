// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal view of the Endaoment OrgFundFactory (Ethereum mainnet).
interface IEndaomentOrgFundFactory {
    /// @notice CREATE2 address of the org for `orgId`, whether or not it is deployed.
    function computeOrgAddress(bytes32 orgId) external view returns (address);

    /// @notice Deploys the org (reverts if already deployed), pulls `amount` USDC from the caller
    ///         (allowance spender is the factory) and credits the org.
    function deployOrgAndDonate(bytes32 orgId, uint256 amount) external returns (address org);

    function registry() external view returns (address);

    function baseToken() external view returns (address);
}
