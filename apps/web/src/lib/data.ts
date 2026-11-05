/** Data loaders: indexer first, chain reads as the fallback for core reads. */
import { isAddress, type Address, type PublicClient } from "viem";
import { chainCurrentEpoch, chainToken, chainTokens, createChainClient } from "./chain-reads";
import type { AppConfig } from "./config";
import { IndexerClient, type TokenSummary } from "./indexer";
import { PRIVATE_RPC_TIMEOUT_MS, type PrivateRpc } from "./private-rpc";

export type Source = "indexer" | "chain";
export interface Sourced<T> {
  data: T;
  source: Source;
}

export interface DataDeps {
  indexer: IndexerClient;
  chain: () => PublicClient;
}

/**
 * `routeIndexer()` is read on every request, so toggling the preference applies immediately.
 * When it is on, indexer requests go through the anon network and Verada never sees the user's IP.
 */
export function createDeps(cfg: AppConfig, rpc: PrivateRpc, routeIndexer: () => boolean = () => false): DataDeps {
  let client: PublicClient | undefined;
  const publicAnon = rpc.fetchFor({ kind: "public" });
  return {
    indexer: new IndexerClient(cfg.indexerUrls, {
      fetchImpl: (input, init) => (routeIndexer() ? publicAnon(input, init) : fetch(input, init)),
      timeoutMs: () => (routeIndexer() ? PRIVATE_RPC_TIMEOUT_MS : 8000),
    }),
    chain: () => (client ??= createChainClient(rpc)),
  };
}

export async function loadTokens(cfg: AppConfig, deps: DataDeps): Promise<Sourced<TokenSummary[]>> {
  try {
    return { data: (await deps.indexer.tokens({ limit: 50 })).items, source: "indexer" };
  } catch (indexerError) {
    try {
      return { data: await chainTokens(deps.chain(), cfg), source: "chain" };
    } catch {
      throw indexerError;
    }
  }
}

export async function loadToken(cfg: AppConfig, deps: DataDeps, address: string): Promise<Sourced<TokenSummary | null>> {
  if (!isAddress(address)) return { data: null, source: "indexer" };
  try {
    return { data: await deps.indexer.token(address), source: "indexer" };
  } catch (indexerError) {
    try {
      return { data: await chainToken(deps.chain(), cfg, address as Address), source: "chain" };
    } catch {
      throw indexerError;
    }
  }
}

export async function loadCurrentEpoch(cfg: AppConfig, deps: DataDeps): Promise<bigint> {
  return chainCurrentEpoch(deps.chain(), cfg);
}
