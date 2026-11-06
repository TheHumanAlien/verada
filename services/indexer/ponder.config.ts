import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import {
  AgentVaultAbi,
  CauseCatalogAbi,
  CuratorRegistryAbi,
  CauseRegistryAbi,
  DonationDistributorAbi,
  EpochGovernorAbi,
  FeeConsolidatorAbi,
  FeeVaultAbi,
  QuoteRegistryAbi,
  TakeoverGovernorAbi,
  TokenProfileRegistryAbi,
  VeradaFactoryAbi,
  ZamaVotingSchemeAbi,
} from "./src/abis";
import { MAINNET_CHAIN_ID, readEnv } from "./src/env";

const env = readEnv(process.env);

export default createConfig({
  chains: {
    mainnet: { id: MAINNET_CHAIN_ID, rpc: env.rpcUrls.length === 1 ? env.rpcUrls[0] : env.rpcUrls },
  },
  contracts: {
    Factory: {
      abi: VeradaFactoryAbi,
      chain: "mainnet",
      address: env.factory,
      startBlock: env.startBlock,
    },
    FeeVault: {
      abi: FeeVaultAbi,
      chain: "mainnet",
      address: env.feeVault,
      startBlock: env.startBlock,
    },
    FeeConsolidator: {
      abi: FeeConsolidatorAbi,
      chain: "mainnet",
      address: env.feeConsolidator,
      startBlock: env.startBlock,
    },
    QuoteRegistry: {
      abi: QuoteRegistryAbi,
      chain: "mainnet",
      address: env.quoteRegistry,
      startBlock: env.startBlock,
    },
    CauseRegistry: {
      abi: CauseRegistryAbi,
      chain: "mainnet",
      address: env.causeRegistry,
      startBlock: env.startBlock,
    },
    CuratorRegistry: {
      abi: CuratorRegistryAbi,
      chain: "mainnet",
      address: env.curatorRegistry,
      startBlock: env.startBlock,
    },
    // One vault per curator agent, created by `registerAgent`.
    AgentVault: {
      abi: AgentVaultAbi,
      chain: "mainnet",
      address: factory({
        address: env.curatorRegistry,
        event: getAbiItem({ abi: CuratorRegistryAbi, name: "AgentRegistered" }),
        parameter: "vault",
      }),
      startBlock: env.startBlock,
    },
    CauseCatalog: {
      abi: CauseCatalogAbi,
      chain: "mainnet",
      address: env.causeCatalog,
      startBlock: env.startBlock,
    },
    EpochGovernor: {
      abi: EpochGovernorAbi,
      chain: "mainnet",
      address: env.epochGovernor,
      startBlock: env.startBlock,
    },
    DonationDistributor: {
      abi: DonationDistributorAbi,
      chain: "mainnet",
      address: env.donationDistributor,
      startBlock: env.startBlock,
    },
    TokenProfileRegistry: {
      abi: TokenProfileRegistryAbi,
      chain: "mainnet",
      address: env.tokenRegistry,
      startBlock: env.startBlock,
    },
    // Ballots for both governors go through the scheme; a replacement scheme needs its own entry.
    ZamaVotingScheme: {
      abi: ZamaVotingSchemeAbi,
      chain: "mainnet",
      address: env.votingScheme,
      startBlock: env.startBlock,
    },
    TakeoverGovernor: {
      abi: TakeoverGovernorAbi,
      chain: "mainnet",
      address: env.takeoverGovernor,
      startBlock: env.startBlock,
    },
  },
});
