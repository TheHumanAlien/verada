// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Stand-in quote asset (WETH or Ondo-like) with configurable decimals and open mint.
contract MockWeth is ERC20 {
    uint8 internal immutable _dec;

    constructor() ERC20("Wrapped Ether", "WETH") {
        _dec = 18;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Locker that only records locks, after checking it owns the NFT. Factory is set once.
contract MockLocker {
    address public factory;
    address public immutable positionManager;
    mapping(address token => uint256) public lpTokenIdOf;
    mapping(address token => bool) public locked;
    uint256 public lockCount;

    error NotFactory();

    constructor(address positionManager_) {
        positionManager = positionManager_;
    }

    function init(address factory_) external {
        require(factory == address(0), "inited");
        factory = factory_;
    }

    function lock(address token, uint256 lpTokenId) external {
        if (msg.sender != factory) revert NotFactory();
        require(IERC721(positionManager).ownerOf(lpTokenId) == address(this), "not owner");
        require(!locked[token], "already locked");
        locked[token] = true;
        lpTokenIdOf[token] = lpTokenId;
        ++lockCount;
    }
}

/// @dev Fee vault that records registrations and deposits.
contract MockFeeVault {
    address public factory;
    mapping(address token => bool) public registered;
    mapping(address token => uint256) public deposited;

    error NotFactory();

    function init(address factory_) external {
        require(factory == address(0), "inited");
        factory = factory_;
    }

    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        registered[token] = true;
    }

    function depositFees(address token, uint256 amount) external {
        deposited[token] += amount;
    }
}

/// @dev Governor that records registrations.
contract MockGovernor {
    address public factory;
    mapping(address token => bool) public registered;

    error NotFactory();

    function init(address factory_) external {
        require(factory == address(0), "inited");
        factory = factory_;
    }

    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        registered[token] = true;
    }
}

/// @dev Quote token with chosen decimals.
contract MockQuote is ERC20 {
    uint8 internal immutable _dec;

    constructor(string memory symbol_, uint8 dec_) ERC20(symbol_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal quote registry: owner-less, for factory tests.
contract MockQuoteRegistry {
    enum Kind {
        Native,
        Ondo
    }

    struct QuoteAsset {
        uint8 decimals;
        Kind kind;
        bool active;
    }

    mapping(address => QuoteAsset) internal _assets;

    function set(address asset, uint8 decimals_, bool ondo, bool active) external {
        _assets[asset] = QuoteAsset(decimals_, ondo ? Kind.Ondo : Kind.Native, active);
    }

    function isAllowed(address asset) external view returns (bool) {
        return _assets[asset].active;
    }

    function getQuoteAsset(address asset) external view returns (QuoteAsset memory) {
        return _assets[asset];
    }
}

/// @dev Pool hook stand-in for factory tests: records fee configs (factory-only) and rejects
///      initialization of pools for tokens it was not told about, like the real hook.
contract MockHook {
    struct FeeConfig {
        uint24 baseFeeBps;
        uint24 sniperFeeStartBps;
        uint32 sniperDecaySeconds;
        uint40 launchTimestamp;
    }

    address public immutable factory;
    mapping(address => FeeConfig) internal _cfg;
    mapping(address => bool) public configured;

    error NotFactory();
    error NotConfigured();

    constructor(address factory_) {
        factory = factory_;
    }

    function configureToken(address token, FeeConfig calldata c) external {
        if (msg.sender != factory) revert NotFactory();
        _cfg[token] = c;
        configured[token] = true;
    }

    function feeConfig(address token) external view returns (FeeConfig memory) {
        return _cfg[token];
    }

    // IHooks.beforeInitialize
    function beforeInitialize(address, PoolKeyLike calldata key, uint160)
        external
        view
        returns (bytes4)
    {
        if (!configured[key.currency0] && !configured[key.currency1]) revert NotConfigured();
        return this.beforeInitialize.selector;
    }

    // IHooks.beforeSwap: no override, no delta
    function beforeSwap(address, PoolKeyLike calldata, SwapParamsLike calldata, bytes calldata)
        external
        pure
        returns (bytes4, int256, uint24)
    {
        return (this.beforeSwap.selector, 0, 0);
    }

    struct PoolKeyLike {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParamsLike {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
}
