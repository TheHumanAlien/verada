import type { Address } from "viem";
import { isAddress } from "viem";

export const MAINNET_CHAIN_ID = 1;

export type IndexerEnv = {
  /** One or more RPC URLs; Ponder load-balances across them and backs off rate-limited ones. */
  rpcUrls: string[];
  factory: Address;
  feeVault: Address;
  feeConsolidator: Address;
  quoteRegistry: Address;
  causeRegistry: Address;
  causeCatalog: Address;
  epochGovernor: Address;
  donationDistributor: Address;
  tokenRegistry: Address;
  votingScheme: Address;
  takeoverGovernor: Address;
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
  const rpcUrls = (env.PONDER_RPC_URL_1 ?? env.ETH_RPC_URL ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (rpcUrls.length === 0) throw new Error("Missing required environment variable PONDER_RPC_URL_1");
  for (const u of rpcUrls) {
    if (!/^(https?|wss?):\/\//.test(u)) throw new Error(`PONDER_RPC_URL_1 entry is not an http(s)/ws(s) URL: ${u}`);
  }
  const start = Number(required(env, "START_BLOCK"));
  if (!Number.isInteger(start) || start <= 0) {
    throw new Error("START_BLOCK must be a positive integer (the deployment block)");
  }
  return {
    rpcUrls,
    factory: address(env, "FACTORY_ADDRESS"),
    feeVault: address(env, "FEE_VAULT_ADDRESS"),
    feeConsolidator: address(env, "FEE_CONSOLIDATOR_ADDRESS"),
    quoteRegistry: address(env, "QUOTE_REGISTRY_ADDRESS"),
    causeRegistry: address(env, "CAUSE_REGISTRY_ADDRESS"),
    causeCatalog: address(env, "CAUSE_CATALOG_ADDRESS"),
    epochGovernor: address(env, "EPOCH_GOVERNOR_ADDRESS"),
    donationDistributor: address(env, "DONATION_DISTRIBUTOR_ADDRESS"),
    tokenRegistry: address(env, "TOKEN_REGISTRY_ADDRESS"),
    votingScheme: address(env, "VOTING_SCHEME_ADDRESS"),
    takeoverGovernor: address(env, "TAKEOVER_GOVERNOR_ADDRESS"),
    startBlock: start,
  };
}
