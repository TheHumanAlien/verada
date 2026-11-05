// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPrivateDonationAdapter
/// @notice Route for donating through a shielded or private-send mechanism. Interface only.
interface IPrivateDonationAdapter {
    /// @notice Emitted when a donation is routed privately.
    event PrivateDonationRouted(bytes32 indexed causeId, address indexed currency, uint256 amount);

    error UnsupportedCurrency(address currency);

    /// @notice Whether `currency` can be routed.
    function supportsCurrency(address currency) external view returns (bool);

    /// @notice Routes `amount` of `currency` to `payout` through the private mechanism.
    /// @param causeId The cause being funded.
    /// @param payout The cause's payout address.
    /// @param currency Currency to send.
    /// @param amount Amount to send.
    /// @param data Scheme-specific payload.
    function donatePrivately(
        bytes32 causeId,
        address payout,
        address currency,
        uint256 amount,
        bytes calldata data
    ) external;
}
