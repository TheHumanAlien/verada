// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {DonationDistributor} from "../src/DonationDistributor.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../src/FeeConsolidator.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {VeradaFactory} from "../src/VeradaFactory.sol";
import {VeradaHook} from "../src/VeradaHook.sol";
import {VeradaLpLocker} from "../src/VeradaLpLocker.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../src/interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {IVeradaHook} from "../src/interfaces/IVeradaHook.sol";
import {IVoteVerifier} from "../src/interfaces/IVoteVerifier.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";

/// @title Deploy
/// @notice Deploys the full Verada system on Ethereum mainnet (or a mainnet fork), mines the hook
///         address, wires roles and writes the resulting addresses to `deployments/<chainid>.json`.
/// @dev Environment for `run()`:
///        OWNER               final owner of the admin contracts (two-step transfer, must accept)
///        PLATFORM_TREASURY   receiver of the platform fee share
///        VERIFIER            vote verifier contract (required, must have code)
///      Example (fork dry run):
///        forge script script/Deploy.s.sol --fork-url $ETH_RPC_URL
contract Deploy is Script {
    // Official Ethereum mainnet deployments (Uniswap v4 deployments page, canonical WETH9).
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant POSITION_MANAGER = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    /// @dev Endaoment's org fund factory on mainnet.
    address internal constant ENDAOMENT_FACTORY = 0x10fD9348136dCea154F752fe0B6dB45Fc298A589;
    /// @dev Consolidator guards: slippage versus spot and spot versus reference, in bps and ticks.
    uint256 internal constant MAX_SLIPPAGE_BPS = 300;
    uint256 internal constant MAX_DEVIATION_TICKS = 1500;
    /// @dev Deterministic CREATE2 deployer present on mainnet; used to place the hook.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant MAX_MINING_ITERATIONS = 2_000_000;

    struct Config {
        address owner;
        address platformTreasury;
        address verifier; // deployed vote verifier, required
    }

    struct Deployment {
        address factory;
        address hook;
        address lpLocker;
        address feeVault;
        address feeConsolidator;
        address quoteRegistry;
        address causeRegistry;
        address epochGovernor;
        address donationDistributor;
        address voteVerifier;
        uint256 deployBlock;
    }

    error WrongChain(uint256 chainId);
    error MissingContract(address account);
    error VerifierRequired();
    error AddressMismatch(string name, address expected, address actual);
    error HookMiningFailed();
    error HookDeploymentFailed();

    function run() external returns (Deployment memory d) {
        Config memory cfg = Config({
            owner: vm.envAddress("OWNER"),
            platformTreasury: vm.envAddress("PLATFORM_TREASURY"),
            verifier: vm.envAddress("VERIFIER")
        });

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(cfg, deployer);
        vm.stopBroadcast();

        _write(d);
        _log(d);
    }

    /// @notice Deploys and wires the system. The caller must already be acting as `deployer`
    ///         (broadcasting or pranking); `deployer` is the account whose nonces are used.
    function deploy(Config memory cfg, address deployer) public returns (Deployment memory d) {
        if (block.chainid != 1) revert WrongChain(block.chainid);
        _requireCode(POOL_MANAGER);
        _requireCode(POSITION_MANAGER);
        _requireCode(WETH);
        _requireCode(USDC);
        _requireCode(ENDAOMENT_FACTORY);
        _requireCode(CREATE2_DEPLOYER);

        // The deployer owns everything during setup; ownership moves to cfg.owner at the end.
        CauseRegistry registry =
            new CauseRegistry(deployer, IEndaomentOrgFundFactory(ENDAOMENT_FACTORY));
        QuoteRegistry quotes = new QuoteRegistry(deployer, USDC, WETH);

        address verifier = cfg.verifier;
        if (verifier == address(0)) revert VerifierRequired();
        _requireCode(verifier);

        EpochGovernor governor =
            new EpochGovernor(deployer, ICauseRegistry(address(registry)), IVoteVerifier(verifier));
        DonationDistributor distributor = new DonationDistributor(
            deployer,
            IEpochGovernor(address(governor)),
            ICauseRegistry(address(registry)),
            IEndaomentOrgFundFactory(ENDAOMENT_FACTORY)
        );

        // The vault, consolidator, hook, locker and factory reference each other through
        // immutables, so their addresses are fixed ahead of time. Each consumes one deployer nonce
        // (the hook through the CREATE2 proxy call), in this order: vault, consolidator, hook,
        // locker, factory. The wiring calls come after all five.
        uint64 nonce = vm.getNonce(deployer);
        address vaultAddr = vm.computeCreateAddress(deployer, nonce);
        address consolidatorAddr = vm.computeCreateAddress(deployer, nonce + 1);
        address lockerAddr = vm.computeCreateAddress(deployer, nonce + 3);
        address factoryAddr = vm.computeCreateAddress(deployer, nonce + 4);

        FeeVault vault = new FeeVault(
            deployer,
            factoryAddr,
            cfg.platformTreasury,
            IEpochGovernor(address(governor)),
            address(distributor),
            USDC
        );
        _expect("feeVault", vaultAddr, address(vault));

        FeeConsolidator consolidator = new FeeConsolidator(
            deployer,
            IPoolManager(POOL_MANAGER),
            IConsolidatorRegistry(address(quotes)),
            IFeeVault(address(vault)),
            WETH,
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
        _expect("feeConsolidator", consolidatorAddr, address(consolidator));

        bytes memory hookArgs = abi.encode(POOL_MANAGER, factoryAddr, consolidatorAddr);
        bytes memory hookInit = abi.encodePacked(type(VeradaHook).creationCode, hookArgs);
        (address hookAddr, bytes32 hookSalt) = _mineHook(hookInit);
        _deployHook(hookSalt, hookInit, hookAddr);

        VeradaLpLocker locker = new VeradaLpLocker(
            POSITION_MANAGER, IFeeConsolidator(address(consolidator)), factoryAddr
        );
        _expect("lpLocker", lockerAddr, address(locker));

        VeradaFactory factory = new VeradaFactory(
            IPoolManager(POOL_MANAGER),
            IPositionManager(POSITION_MANAGER),
            IQuoteRegistry(address(quotes)),
            IVeradaHook(hookAddr),
            ILpLocker(address(locker)),
            IFeeVault(address(vault)),
            IEpochGovernor(address(governor))
        );
        _expect("factory", factoryAddr, address(factory));

        // Wiring.
        governor.setFactory(address(factory));
        distributor.setFeeVault(address(vault));
        vault.setConsolidator(address(consolidator));
        consolidator.setHook(hookAddr);
        consolidator.setSource(address(locker), true);

        // Hand over ownership (two-step: cfg.owner must call acceptOwnership on each).
        if (cfg.owner != deployer) {
            registry.transferOwnership(cfg.owner);
            governor.transferOwnership(cfg.owner);
            distributor.transferOwnership(cfg.owner);
            vault.transferOwnership(cfg.owner);
            quotes.transferOwnership(cfg.owner);
            consolidator.transferOwnership(cfg.owner);
        }

        d = Deployment({
            factory: address(factory),
            hook: hookAddr,
            lpLocker: address(locker),
            feeVault: address(vault),
            feeConsolidator: address(consolidator),
            quoteRegistry: address(quotes),
            causeRegistry: address(registry),
            epochGovernor: address(governor),
            donationDistributor: address(distributor),
            voteVerifier: verifier,
            deployBlock: block.number
        });
    }

    // ------------------------------------------------------------------ hook mining

    function _mineHook(bytes memory initCode) internal pure returns (address hook, bytes32 salt) {
        bytes32 initCodeHash = keccak256(initCode);
        uint160 mask = Hooks.ALL_HOOK_MASK;
        for (uint256 i; i < MAX_MINING_ITERATIONS; ++i) {
            salt = bytes32(i);
            hook = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)
                        )
                    )
                )
            );
            if (uint160(hook) & mask == HOOK_FLAGS) return (hook, salt);
        }
        revert HookMiningFailed();
    }

    function _deployHook(bytes32 salt, bytes memory initCode, address expected) internal {
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        if (!ok || expected.code.length == 0) revert HookDeploymentFailed();
    }

    // ------------------------------------------------------------------ helpers

    function _requireCode(address account) internal view {
        if (account.code.length == 0) revert MissingContract(account);
    }

    function _expect(string memory name, address expected, address actual) internal pure {
        if (expected != actual) revert AddressMismatch(name, expected, actual);
    }

    function _write(Deployment memory d) internal {
        string memory k = "verada";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", d.deployBlock);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "hook", d.hook);
        vm.serializeAddress(k, "lpLocker", d.lpLocker);
        vm.serializeAddress(k, "feeVault", d.feeVault);
        vm.serializeAddress(k, "feeConsolidator", d.feeConsolidator);
        vm.serializeAddress(k, "quoteRegistry", d.quoteRegistry);
        vm.serializeAddress(k, "causeRegistry", d.causeRegistry);
        vm.serializeAddress(k, "epochGovernor", d.epochGovernor);
        vm.serializeAddress(k, "donationDistributor", d.donationDistributor);
        string memory json = vm.serializeAddress(k, "voteVerifier", d.voteVerifier);

        vm.createDir("deployments", true);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    function _log(Deployment memory d) internal pure {
        console2.log("factory", d.factory);
        console2.log("hook", d.hook);
        console2.log("lpLocker", d.lpLocker);
        console2.log("feeVault", d.feeVault);
        console2.log("feeConsolidator", d.feeConsolidator);
        console2.log("quoteRegistry", d.quoteRegistry);
        console2.log("causeRegistry", d.causeRegistry);
        console2.log("epochGovernor", d.epochGovernor);
        console2.log("donationDistributor", d.donationDistributor);
        console2.log("voteVerifier", d.voteVerifier);
    }
}
