// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal view of the Endaoment registry (Ethereum mainnet).
interface IEndaomentRegistry {
    function isActiveEntity(address entity) external view returns (bool);

    /// @notice Default donation fee for `entity` in zoc (10000 = 100%).
    function getDonationFee(address entity) external view returns (uint32);

    function baseToken() external view returns (address);

    function treasury() external view returns (address);
}
