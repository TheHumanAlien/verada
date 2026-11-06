// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Gas measurement of several transactions inside one test: `_cool` runs `vm.cool` over
///      `_coldSet`, marking those accounts and their storage slots cold again, so each measured
///      step pays cold access the way its own transaction would. The test lists every account its
///      steps touch, proxies with their implementations (`_addProxy`). The list is kept by hand on
///      purpose: state-diff recording (`vm.startStateDiffRecording`) lowers the gas of fresh
///      SSTOREs while it runs, and even after a `vm.revertToState` that discards the recorded
///      steps, so no measured step may follow it. Cross-check new figures with `forge test
///      --isolate`, which runs each call as its own transaction (base and calldata gas included).
///      Slots written by an earlier step still count as dirty within the test, so a rewrite costs
///      100 gas instead of 2,900: the figures slightly undercount steps that overwrite earlier
///      writes.
abstract contract ColdGas is Test {
    /// @dev ERC-1967 implementation slot.
    bytes32 private constant _IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address[] internal _coldSet;

    /// @dev Adds `proxy` and, when it is an ERC-1967 proxy, its implementation.
    function _addProxy(address proxy) internal {
        _coldSet.push(proxy);
        address impl = address(uint160(uint256(vm.load(proxy, _IMPL_SLOT))));
        if (impl != address(0)) _coldSet.push(impl);
    }

    function _cool() internal {
        uint256 n = _coldSet.length;
        for (uint256 i; i < n; ++i) {
            vm.cool(_coldSet[i]);
        }
    }
}
