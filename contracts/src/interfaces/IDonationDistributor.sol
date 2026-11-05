// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IDonationDistributor
/// @notice Pays an epoch's cause funds (USDC) to the winning Endaoment org. Deployed orgs get
///         `donate`; undeployed orgs get `deployOrgAndDonate` (decided on-chain by code length).
interface IDonationDistributor {
    /// @notice Emitted when funds are donated. `amount` is the gross USDC sent.
    event Donated(
        address indexed token,
        uint256 indexed epoch,
        bytes32 indexed causeId,
        address payout,
        uint256 amount
    );

    /// @notice Emitted when the org had to be deployed as part of the donation.
    event OrgDeployed(bytes32 indexed orgId, address indexed org);

    error EpochNotFinalized(address token, uint256 epoch);
    error AlreadyDistributed(address token, uint256 epoch);
    error NothingToDistribute(address token, uint256 epoch);
    error NotFeeVault();
    error OrgNotActive(address org);
    error OrgAddressMismatch(bytes32 orgId, address expected, address actual);

    /// @notice The settlement asset donated (USDC).
    function settlementAsset() external view returns (address);

    /// @notice Records funds received from the fee vault for an epoch.
    function receiveFunds(address token, uint256 epoch, uint256 amount) external;

    /// @notice Sends the epoch's funds to the winning cause: `donate` if the org exists,
    ///         else `deployOrgAndDonate`. Guards with registry.isActiveEntity for deployed orgs.
    function distribute(address token, uint256 epoch) external;

    /// @notice Current Endaoment donation fee for `org`, in zoc (10000 = 100%), read from the registry.
    function endaomentFeeFor(address org) external view returns (uint32);

    /// @notice Whether the epoch has been distributed.
    function distributed(address token, uint256 epoch) external view returns (bool);

    /// @notice Funds held for an epoch in the settlement asset.
    function pending(address token, uint256 epoch) external view returns (uint256);
}
