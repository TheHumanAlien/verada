// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {VeradaHook} from "../src/VeradaHook.sol";
import {HookMiner} from "./HookMiner.sol";

/// @notice Prints the CREATE2 salt and address for VeradaHook. Read-only; broadcasts nothing.
/// @dev Env: POOL_MANAGER, FACTORY, FEE_CONSOLIDATOR (the hook's constructor arguments).
///      `CREATE2_DEPLOYER` defaults to the deterministic deployer used by forge for
///      `new X{salt: ...}` in scripts.
contract MineVeradaHookSalt is Script {
    address internal constant DEFAULT_CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external view returns (address hookAddress, bytes32 salt) {
        address deployer = vm.envOr("CREATE2_DEPLOYER", DEFAULT_CREATE2_DEPLOYER);
        bytes memory args = abi.encode(
            IPoolManager(vm.envAddress("POOL_MANAGER")),
            vm.envAddress("FACTORY"),
            vm.envAddress("FEE_CONSOLIDATOR")
        );
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (hookAddress, salt) = HookMiner.find(deployer, flags, type(VeradaHook).creationCode, args);
        console.log("hook", hookAddress);
        console.logBytes32(salt);
    }
}
