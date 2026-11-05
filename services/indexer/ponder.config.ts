import { createConfig } from "ponder";
import {
  CauseRegistryAbi,
  DonationDistributorAbi,
  EpochGovernorAbi,
  FeeConsolidatorAbi,
  FeeVaultAbi,
  QuoteRegistryAbi,
  VeradaFactoryAbi,
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
  },
});
