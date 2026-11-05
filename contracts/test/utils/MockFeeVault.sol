// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal stand-in for FeeVault used by hook tests: records deposits and checks the
///      funds were transferred before `depositFees` is called.
contract MockFeeVault {
    address public hook;
    mapping(address token => mapping(address currency => uint256)) public deposited;
    mapping(address currency => uint256) public totalDeposited;
    uint256 public calls;

    error NotHook();
    error NotFunded();

    function setHook(address _hook) external {
        hook = _hook;
    }

    function depositFees(address token, address currency, uint256 amount) external {
        if (msg.sender != hook) revert NotHook();
        totalDeposited[currency] += amount;
        if (IERC20(currency).balanceOf(address(this)) < totalDeposited[currency]) {
            revert NotFunded();
        }
        deposited[token][currency] += amount;
        calls++;
    }
}
