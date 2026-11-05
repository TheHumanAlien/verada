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
import {TakeoverGovernor} from "../src/TakeoverGovernor.sol";
import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {VeradaFactory} from "../src/VeradaFactory.sol";
import {VeradaHook} from "../src/VeradaHook.sol";
import {VeradaLpLocker} from "../src/VeradaLpLocker.sol";
import {VeradaResolver} from "../src/VeradaResolver.sol";
import {ZamaVotingScheme} from "../src/governance/ZamaVotingScheme.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../src/interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {ITakeoverGovernor} from "../src/interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaHook} from "../src/interfaces/IVeradaHook.sol";
import {IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {ContenthashLib} from "../src/libraries/ContenthashLib.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";

/// @title Deploy
/// @notice Deploys the full Verada system on Ethereum mainnet (or a mainnet fork), mines the hook
///         address, wires roles and writes the resulting addresses to `deployments/<chainid>.json`.
/// @dev Environment for `run()`:
///        OWNER               final owner of the admin contracts (two-step transfer, must accept)
///        PLATFORM_TREASURY   receiver of the platform fee share; also the `addr` of verada.eth
///        SITE_SWARM_REF      optional bytes32 Swarm reference (the site feed manifest) stored as
///                            the default contenthash served for every ENS name
///      Example (fork dry run):
///        forge script script/Deploy.s.sol --fork-url $ETH_RPC_URL
///
///      Manual steps after deployment (not transactions this script can send):
///        1. The owner of `verada.eth` on ENSv2 calls
///           `ETHRegistry(0xf60aba43e1f7f3dab1186ff03b561401c9df85e2).setResolver(
///               uint256(keccak256("verada")), <resolver>)`.
///        2. The owner accepts ownership of every admin contract, adds causes, sets the default
///           shortlist (`EpochGovernor.setDefaultShortlist`) and the default cause, and, after the
///           first site publish, `TokenProfileRegistry.setDefaultContenthash` if SITE_SWARM_REF was
///           not known at deploy time.
///        3. Fund the Zama fee account used by the tally keeper (see services/publisher).
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
    /// @dev DNS wire-format encoding of `verada.eth`, the parent of every token subname.
    bytes internal constant PARENT_DNS_NAME = hex"067665726164610365746800";

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant MAX_MINING_ITERATIONS = 2_000_000;

    struct Config {
        address owner;
        address platformTreasury;
        /// @dev Swarm reference of the site feed manifest; zero leaves the contenthash unset.
        bytes32 siteSwarmRef;
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
        address profileRegistry;
        address resolver;
        address takeoverGovernor;
        address votingScheme;
        uint256 deployBlock;
    }

    error WrongChain(uint256 chainId);
    error MissingContract(address account);
    error AddressMismatch(string name, address expected, address actual);
    error HookMiningFailed();
    error HookDeploymentFailed();

    function run() external returns (Deployment memory d) {
        Config memory cfg = Config({
            owner: vm.envAddress("OWNER"),
            platformTreasury: vm.envAddress("PLATFORM_TREASURY"),
            siteSwarmRef: vm.envOr("SITE_SWARM_REF", bytes32(0))
        });

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(cfg, deployer);
        vm.stopBroadcast();

        _write(d);
        _log(d);
    }

    /// @notice Initial takeover parameters: one-week vote and execution window, two weeks of
    ///         cooldown and minimum token age, 3% quorum, 0.25% proposal threshold.
    function defaultTakeoverParams() public pure returns (ITakeoverGovernor.Params memory) {
        return ITakeoverGovernor.Params({
            votingPeriod: 7 days,
            executionWindow: 7 days,
            cooldown: 14 days,
            minTokenAge: 14 days,
            quorumBps: 300,
            proposalThresholdBps: 25
        });
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
        // The scheme reads the Zama coprocessor config for the current chain (mainnet here).
        ZamaVotingScheme scheme = new ZamaVotingScheme(deployer);

        // The profile registry, governor, distributor, vault, consolidator, hook, locker and
        // factory reference each other through immutables, so their addresses are fixed ahead of
        // time. Each consumes one deployer nonce (the hook through the CREATE2 proxy call), in
        // this order: profile registry, governor, distributor, vault, consolidator, hook, locker,
        // factory. The wiring calls come after all eight.
        uint64 nonce = vm.getNonce(deployer);
        address profileRegistryAddr = vm.computeCreateAddress(deployer, nonce);
        address vaultAddr = vm.computeCreateAddress(deployer, nonce + 3);
        address consolidatorAddr = vm.computeCreateAddress(deployer, nonce + 4);
        address lockerAddr = vm.computeCreateAddress(deployer, nonce + 6);
        address factoryAddr = vm.computeCreateAddress(deployer, nonce + 7);

        TokenProfileRegistry profiles = new TokenProfileRegistry(
            deployer, factoryAddr, DnsNameLib.namehash(PARENT_DNS_NAME, 0)
        );
        _expect("profileRegistry", profileRegistryAddr, address(profiles));

        EpochGovernor governor = new EpochGovernor(
            deployer,
            ICauseRegistry(address(registry)),
            IVotingScheme(address(scheme)),
            ITokenProfileRegistry(address(profiles))
        );
        DonationDistributor distributor = new DonationDistributor(
            deployer,
            IEpochGovernor(address(governor)),
            ICauseRegistry(address(registry)),
            IEndaomentOrgFundFactory(ENDAOMENT_FACTORY)
        );

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
            IEpochGovernor(address(governor)),
            ITokenProfileRegistry(address(profiles))
        );
        _expect("factory", factoryAddr, address(factory));

        // ENS resolver (stateless) and the takeover governor need no address prediction.
        VeradaResolver resolver =
            new VeradaResolver(ITokenProfileRegistry(address(profiles)), PARENT_DNS_NAME);
        TakeoverGovernor takeover = new TakeoverGovernor(
            deployer,
            ITokenProfileRegistry(address(profiles)),
            IVotingScheme(address(scheme)),
            defaultTakeoverParams()
        );

        // Wiring.
        governor.setFactory(address(factory));
        distributor.setFeeVault(address(vault));
        vault.setConsolidator(address(consolidator));
        consolidator.setHook(hookAddr);
        consolidator.setSource(address(locker), true);
        scheme.setGovernor(address(governor), true);
        scheme.setGovernor(address(takeover), true);
        profiles.setGovernor(address(takeover));
        profiles.setPlatformAddress(cfg.platformTreasury);
        if (cfg.siteSwarmRef != bytes32(0)) {
            profiles.setDefaultContenthash(ContenthashLib.swarm(cfg.siteSwarmRef));
        }

        // Hand over ownership (two-step: cfg.owner must call acceptOwnership on each).
        if (cfg.owner != deployer) {
            registry.transferOwnership(cfg.owner);
            governor.transferOwnership(cfg.owner);
            distributor.transferOwnership(cfg.owner);
            vault.transferOwnership(cfg.owner);
            quotes.transferOwnership(cfg.owner);
            consolidator.transferOwnership(cfg.owner);
            profiles.transferOwnership(cfg.owner);
            scheme.transferOwnership(cfg.owner);
            takeover.transferOwnership(cfg.owner);
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
            profileRegistry: address(profiles),
            resolver: address(resolver),
            takeoverGovernor: address(takeover),
            votingScheme: address(scheme),
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
        vm.serializeAddress(k, "profileRegistry", d.profileRegistry);
        vm.serializeAddress(k, "resolver", d.resolver);
        vm.serializeAddress(k, "takeoverGovernor", d.takeoverGovernor);
        string memory json = vm.serializeAddress(k, "votingScheme", d.votingScheme);

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
        console2.log("profileRegistry", d.profileRegistry);
        console2.log("resolver", d.resolver);
        console2.log("takeoverGovernor", d.takeoverGovernor);
        console2.log("votingScheme", d.votingScheme);
    }
}
