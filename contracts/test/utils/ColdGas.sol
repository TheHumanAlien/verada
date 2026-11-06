// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

/// @dev Gas measurement of several transactions inside one test: `_cool` marks accounts cold
///      again (addresses and storage), so each measured step pays cold access the way its own
///      transaction would. With `_coldSet` empty it cools every account touched since the previous
///      call (state-diff recording between `_startCold` and `_stopCold`); a test whose mocks touch
///      too much storage for that lists its accounts in `_coldSet` instead. Slots written by an
///      earlier step still count as dirty within the test, so a rewrite costs 100 gas instead of
///      2,900: the figures slightly undercount steps that overwrite earlier writes.
abstract contract ColdGas is Test {
    address[] internal _coldSet;

    function _startCold() internal {
        if (_coldSet.length == 0) vm.startStateDiffRecording();
    }

    function _cool() internal {
        uint256 n = _coldSet.length;
        if (n != 0) {
            for (uint256 i; i < n; ++i) {
                vm.cool(_coldSet[i]);
            }
            return;
        }
        Vm.AccountAccess[] memory a = vm.stopAndReturnStateDiff();
        for (uint256 i; i < a.length; ++i) {
            if (a[i].account != address(vm)) vm.cool(a[i].account);
            if (a[i].accessor != address(vm)) vm.cool(a[i].accessor);
        }
        vm.startStateDiffRecording();
    }

    function _stopCold() internal {
        if (_coldSet.length == 0) vm.stopAndReturnStateDiff();
    }
}
