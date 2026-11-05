import type { Address } from "viem";
import { isAddress } from "viem";

export const MAINNET_CHAIN_ID = 1;

export type IndexerEnv = {
  rpcUrl: string;
  factory: Address;
  feeVault: Address;
  feeConsolidator: Address;
  quoteRegistry: Address;
  causeRegistry: Address;
  epochGovernor: Address;
  donationDistributor: Address;
  startBlock: number;
};

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function address(env: Record<string, string | undefined>, key: string): Address {
  const v = required(env, key);
  if (!isAddress(v)) throw new Error(`${key} is not a valid address`);
  return v;
}

/** Reads and validates indexer configuration. Mainnet only. */
export function readEnv(env: Record<string, string | undefined>): IndexerEnv {
  const rpcUrl = env.PONDER_RPC_URL_1 ?? env.ETH_RPC_URL;
  if (!rpcUrl) throw new Error("Missing required environment variable PONDER_RPC_URL_1");
  const start = Number(required(env, "START_BLOCK"));
  if (!Number.isInteger(start) || start <= 0) {
    throw new Error("START_BLOCK must be a positive integer (the deployment block)");
  }
  return {
    rpcUrl,
    factory: address(env, "FACTORY_ADDRESS"),
    feeVault: address(env, "FEE_VAULT_ADDRESS"),
    feeConsolidator: address(env, "FEE_CONSOLIDATOR_ADDRESS"),
    quoteRegistry: address(env, "QUOTE_REGISTRY_ADDRESS"),
    causeRegistry: address(env, "CAUSE_REGISTRY_ADDRESS"),
    epochGovernor: address(env, "EPOCH_GOVERNOR_ADDRESS"),
    donationDistributor: address(env, "DONATION_DISTRIBUTOR_ADDRESS"),
    startBlock: start,
  };
}
