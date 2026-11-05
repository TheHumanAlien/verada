// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";

import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {ILpLocker} from "./interfaces/ILpLocker.sol";

/// @dev The subset of the v4 position manager used by the locker. `info` is the packed
///      position info word.
interface ILockerPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, uint256 info);
}

/// @title VeradaLpLocker
/// @notice Holds liquidity position NFTs forever. The only liquidity operation it can perform is
///         a zero-liquidity decrease, which settles accrued fees without touching principal.
///         There is no function that transfers an NFT or removes liquidity.
contract VeradaLpLocker is ILpLocker, IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error NotPositionOwner(uint256 lpTokenId);
    error UnexpectedNft();

    /// @notice The v4 position manager whose NFTs are held.
    address public immutable positionManager;

    /// @notice The consolidator receiving collected raw fees (swapped to USDC, then split).
    IFeeConsolidator public immutable feeConsolidator;

    /// @notice The factory allowed to lock positions.
    address public immutable factory;

    mapping(address token => uint256 id) private _lpTokenIdOf;
    mapping(address token => bool locked) private _locked;
    mapping(uint256 id => bool locked) public isLockedId;
    /// @inheritdoc ILpLocker
    mapping(address token => uint256 timestamp) public lastCollectedAt;

    constructor(address positionManager_, IFeeConsolidator feeConsolidator_, address factory_) {
        if (
            positionManager_ == address(0) || address(feeConsolidator_) == address(0)
                || factory_ == address(0)
        ) {
            revert ZeroAddress();
        }
        positionManager = positionManager_;
        feeConsolidator = feeConsolidator_;
        factory = factory_;
    }

    /// @inheritdoc ILpLocker
    function lock(address token, uint256 lpTokenId) external {
        if (msg.sender != factory) revert NotFactory();
        if (_locked[token]) revert AlreadyLocked(token);
        if (IERC721(positionManager).ownerOf(lpTokenId) != address(this)) {
            revert NotPositionOwner(lpTokenId);
        }
        _locked[token] = true;
        _lpTokenIdOf[token] = lpTokenId;
        isLockedId[lpTokenId] = true;
        lastCollectedAt[token] = block.timestamp;
        emit Locked(token, lpTokenId);
    }

    /// @inheritdoc ILpLocker
    function lpTokenIdOf(address token) external view returns (uint256) {
        if (!_locked[token]) revert NotLocked(token);
        return _lpTokenIdOf[token];
    }

    /// @inheritdoc ILpLocker
    /// @dev Permissionless. Fees are taken to this contract, measured by balance delta, forwarded
    ///      to the consolidator and registered there as earned since the previous collection, so
    ///      each epoch of that interval keeps its time share whoever collects and whenever.
    ///      Consolidation failures are held by the consolidator, not reverted.
    function collectFees(address token)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (!_locked[token]) revert NotLocked(token);
        uint256 id = _lpTokenIdOf[token];
        uint256 since = lastCollectedAt[token];
        lastCollectedAt[token] = block.timestamp;

        (PoolKey memory key,) = ILockerPositionManager(positionManager).getPoolAndPositionInfo(id);
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);

        uint256 before0 = IERC20(currency0).balanceOf(address(this));
        uint256 before1 = IERC20(currency1).balanceOf(address(this));

        // DECREASE_LIQUIDITY with zero liquidity settles fees only; TAKE_PAIR pays them out here.
        bytes memory actions =
            abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        ILockerPositionManager(positionManager)
            .modifyLiquidities(abi.encode(actions, params), block.timestamp);

        amount0 = IERC20(currency0).balanceOf(address(this)) - before0;
        amount1 = IERC20(currency1).balanceOf(address(this)) - before1;

        if (amount0 != 0) _forward(token, currency0, amount0, since);
        if (amount1 != 0) _forward(token, currency1, amount1, since);
    }

    /// @inheritdoc IERC721Receiver
    /// @dev Only NFTs minted by the configured position manager are accepted.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != positionManager) revert UnexpectedNft();
        return IERC721Receiver.onERC721Received.selector;
    }

    function _forward(address token, address currency, uint256 amount, uint256 since) private {
        IERC20(currency).safeTransfer(address(feeConsolidator), amount);
        feeConsolidator.consolidateAccrued(token, currency, amount, since);
    }
}
