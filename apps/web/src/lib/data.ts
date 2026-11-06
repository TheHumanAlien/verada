/** Data loaders: indexer first, chain reads as the fallback for core reads. */
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import {
  chainCurrentEpoch,
  chainEpochDetail,
  chainTakeovers,
  chainToken,
  chainTokenByLabel,
  chainTokenDetail,
  chainTokens,
  createChainClient,
} from "./chain-reads";
import type { AppConfig } from "./config";
import { IndexerClient, type CauseSummary, type EpochDetail, type TakeoverItem, type TokenDetail, type TokenSummary } from "./indexer";
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

/** Indexer first; the chain when every indexer URL fails. Rethrows the indexer error if both fail. */
async function indexerThenChain<T>(fromIndexer: () => Promise<T>, fromChain: () => Promise<T>): Promise<Sourced<T>> {
  try {
    return { data: await fromIndexer(), source: "indexer" };
  } catch (indexerError) {
    try {
      return { data: await fromChain(), source: "chain" };
    } catch {
      throw indexerError;
    }
  }
}

export async function loadTokenDetail(cfg: AppConfig, deps: DataDeps, address: string): Promise<Sourced<TokenDetail | null>> {
  if (!isAddress(address)) return { data: null, source: "indexer" };
  return indexerThenChain(
    () => deps.indexer.tokenDetail(address),
    () => chainTokenDetail(deps.chain(), cfg, address as Address),
  );
}

/**
 * Token address for an ENS label: resolved on-chain (ENS, then the profile registry) through the
 * public-scope private RPC, with the indexer's by-label route as the fallback.
 */
export async function resolveTokenLabel(cfg: AppConfig, deps: DataDeps, label: string): Promise<Sourced<Address | null>> {
  let chainError: unknown;
  try {
    const a = await chainTokenByLabel(deps.chain(), cfg, label);
    if (a) return { data: a, source: "chain" };
  } catch (e) {
    chainError = e;
  }
  try {
    const t = await deps.indexer.tokenByLabel(label);
    return { data: t && isAddress(t.address) ? getAddress(t.address) : null, source: "indexer" };
  } catch (e) {
    throw chainError ?? e;
  }
}

export interface EpochView {
  epoch: bigint;
  detail: EpochDetail | null;
  source: Source;
}

/**
 * The current epoch (a chain read) and its state, indexer first. `chainFirst` reads the chain
 * first instead, for a ballot just opened from this page: the indexer reports it only once it has
 * indexed that block.
 */
export async function loadEpochView(cfg: AppConfig, deps: DataDeps, token: Address, opts: { chainFirst?: boolean } = {}): Promise<EpochView> {
  const epoch = await chainCurrentEpoch(deps.chain(), cfg);
  const fromIndexer = () => deps.indexer.epochDetail(token, epoch);
  const fromChain = () => chainEpochDetail(deps.chain(), cfg, token, epoch);
  if (opts.chainFirst) {
    try {
      return { epoch, detail: await fromChain(), source: "chain" };
    } catch {
      // The RPC failed: the indexer's view, possibly still without the opening, is all there is.
    }
  }
  const r = await indexerThenChain(fromIndexer, fromChain);
  return { epoch, detail: r.data, source: r.source };
}

export async function loadTakeovers(cfg: AppConfig, deps: DataDeps, token: Address): Promise<Sourced<TakeoverItem[]>> {
  return indexerThenChain(
    () => deps.indexer.takeovers(token),
    () => chainTakeovers(deps.chain(), cfg, token),
  );
}

/** Registry causes keyed by lowercase cause id. Indexer only (names are off-chain metadata). */
export async function loadCauses(deps: DataDeps): Promise<Map<string, CauseSummary>> {
  const all = new Map<string, CauseSummary>();
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await deps.indexer.causes({ cursor, limit: 100 });
    for (const c of page.items) all.set(c.causeId.toLowerCase(), c);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}
