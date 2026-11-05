// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";

contract VaultTestToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockGovernor {
    mapping(address => mapping(uint256 => bool)) public isFinalized;

    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 e) external {
        currentEpoch = e;
    }

    function setFinalized(address token, uint256 epoch, bool v) external {
        isFinalized[token][epoch] = v;
    }
}

contract MockDistributor {
    mapping(address => mapping(uint256 => mapping(address => uint256))) public received;

    function receiveFunds(address token, uint256 epoch, address currency, uint256 amount) external {
        received[token][epoch][currency] += amount;
    }
}

/// @dev Minimal position manager: NFT ownership, pool key lookup and a restricted
///      modifyLiquidities that pays out pre-seeded fees. Liquidity (principal) is tracked so tests
///      can assert it never decreases.
contract MockPositionManager {
    PoolKey public key;
    mapping(uint256 id => uint256) public liquidity;
    mapping(uint256 id => uint256) public fees0;
    mapping(uint256 id => uint256) public fees1;
    uint256 public nextId = 1;
    mapping(uint256 id => address) public ownerOf;

    constructor(address currency0, address currency1) {
        key = PoolKey(
            Currency.wrap(currency0), Currency.wrap(currency1), 0x800000, 60, IHooks(address(0))
        );
    }

    function mintTo(address to, uint256 liq) external returns (uint256 id) {
        id = nextId++;
        liquidity[id] = liq;
        ownerOf[id] = to;
    }

    function accrue(uint256 id, uint256 a0, uint256 a1) external {
        fees0[id] += a0;
        fees1[id] += a1;
    }

    function getPoolAndPositionInfo(uint256) external view returns (PoolKey memory, uint256) {
        return (key, 0);
    }

    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        uint256 id;
        for (uint256 i; i < actions.length; ++i) {
            uint8 a = uint8(actions[i]);
            if (a == Actions.DECREASE_LIQUIDITY) {
                (uint256 tokenId, uint256 liq,,,) =
                    abi.decode(params[i], (uint256, uint256, uint128, uint128, bytes));
                require(ownerOf[tokenId] == msg.sender, "not owner");
                require(liq == 0, "principal removal");
                id = tokenId;
            } else if (a == Actions.TAKE_PAIR) {
                (Currency c0, Currency c1, address to) =
                    abi.decode(params[i], (Currency, Currency, address));
                uint256 f0 = fees0[id];
                uint256 f1 = fees1[id];
                fees0[id] = 0;
                fees1[id] = 0;
                VaultTestToken(Currency.unwrap(c0)).transfer(to, f0);
                VaultTestToken(Currency.unwrap(c1)).transfer(to, f1);
            } else {
                revert("unsupported action");
            }
        }
    }
}

/// @dev Records what the locker delivers, and checks that the tokens arrived first.
contract MockFeeConsolidator {
    mapping(address token => mapping(address currency => uint256)) public delivered;
    mapping(address currency => uint256) public totalDelivered;
    bool public failing;

    function setFailing(bool v) external {
        failing = v;
    }

    /// @dev `accruedSince` of the last delivery made through `consolidateAccrued`.
    uint256 public lastAccruedSince;
    uint256 public accruedCalls;

    function consolidateAccrued(address token, address currency, uint256 amount, uint256 since)
        external
    {
        lastAccruedSince = since;
        accruedCalls++;
        consolidate(token, currency, amount);
    }

    function consolidate(address token, address currency, uint256 amount) public {
        require(!failing, "consolidator down");
        delivered[token][currency] += amount;
        totalDelivered[currency] += amount;
        require(
            VaultTestToken(currency).balanceOf(address(this)) >= totalDelivered[currency],
            "unbacked"
        );
    }
}
