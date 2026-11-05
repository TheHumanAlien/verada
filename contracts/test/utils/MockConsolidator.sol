// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

/// @dev Stand-in for FeeConsolidator in hook tests: records pool registrations and raw fee
///      deliveries, and checks the funds arrived before `consolidate` is called.
contract MockConsolidator {
    address public hook;
    mapping(address token => mapping(address currency => uint256)) public deposited;
    mapping(address currency => uint256) public totalDeposited;
    mapping(address token => PoolKey) public registered;
    mapping(address token => bool) public isRegistered;
    uint256 public calls;

    error NotHook();
    error NotFunded();

    function setHook(address _hook) external {
        hook = _hook;
    }

    function registerPool(address token, PoolKey calldata key) external {
        if (msg.sender != hook) revert NotHook();
        registered[token] = key;
        isRegistered[token] = true;
    }

    function consolidate(address token, address currency, uint256 amount) external {
        if (msg.sender != hook) revert NotHook();
        totalDeposited[currency] += amount;
        if (IERC20(currency).balanceOf(address(this)) < totalDeposited[currency]) {
            revert NotFunded();
        }
        deposited[token][currency] += amount;
        calls++;
    }
}
