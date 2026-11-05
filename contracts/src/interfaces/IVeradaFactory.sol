// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVeradaFactory
/// @notice Deploys tokens, initializes their Uniswap v4 pool and locks single-sided liquidity.
interface IVeradaFactory {
    /// @notice Parameters for launching a token.
    /// @param name ERC20 name.
    /// @param symbol ERC20 symbol.
    /// @param metadataURI Token metadata URI.
    /// @param salt CREATE2 salt used to deploy the token.
    /// @param baseFeeBps Base pool fee in basis points, within the allowed fee range.
    /// @param sniperFeeStartBps Initial anti-sniper surcharge in basis points (0 disables it).
    /// @param sniperDecaySeconds Seconds over which the surcharge decays to zero.
    /// @param startTick Initial pool tick at which single-sided liquidity begins.
    /// @param quoteAsset Asset the token is paired against; must be allowed by the QuoteRegistry
    ///        (WETH or an Ondo token).
    struct DeployParams {
        string name;
        string symbol;
        string metadataURI;
        bytes32 salt;
        uint24 baseFeeBps;
        uint24 sniperFeeStartBps;
        uint32 sniperDecaySeconds;
        int24 startTick;
        address quoteAsset;
    }

    /// @notice Emitted when a token is launched.
    /// @param token The new token.
    /// @param creator The launching account.
    /// @param pool The v4 pool id.
    /// @param hook The hook attached to the pool.
    /// @param lpTokenId The locked liquidity position NFT id.
    /// @param feeBps Base fee in basis points.
    /// @param metadataURI Token metadata URI.
    event TokenCreated(
        address indexed token,
        address indexed creator,
        bytes32 pool,
        address hook,
        uint256 lpTokenId,
        uint24 feeBps,
        string metadataURI
    );

    error InvalidFee(uint24 feeBps);
    error InvalidSniperFee(uint24 feeBps);
    error TokenAlreadyDeployed(address token);
    error QuoteAssetNotAllowed(address quoteAsset);

    /// @notice Launches a token, initializes its pool and locks the liquidity.
    /// @return token The deployed token address.
    /// @return lpTokenId The locked position NFT id.
    function deployToken(DeployParams calldata params)
        external
        payable
        returns (address token, uint256 lpTokenId);

    /// @notice Predicts the token address for a creator and params.
    function predictTokenAddress(address creator, DeployParams calldata params)
        external
        view
        returns (address);

    /// @notice The registry validating quote assets.
    function quoteRegistry() external view returns (address);

    /// @notice Quote asset a launched token is paired against.
    function quoteAssetOf(address token) external view returns (address);

    /// @notice Number of tokens launched.
    function tokenCount() external view returns (uint256);

    /// @notice Whether `token` was launched by this factory.
    function isVeradaToken(address token) external view returns (bool);
}
