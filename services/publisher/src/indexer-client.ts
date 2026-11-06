import type { Hex } from "viem";
import { z } from "zod";
import type { EntryWithProof, PickWithProof } from "./keeper/ballot.js";
import {
  IndexerCausePageSchema,
  IndexerCauseSchema,
  IndexerTokenPageSchema,
  IndexerTokenSchema,
  parseItems,
  type IndexerCause,
  type IndexerToken,
} from "@verada/arkiv-registry";

export interface IndexerClient {
  listTokens(): Promise<{ items: IndexerToken[]; rejected: number }>;
  listCauses(): Promise<{ items: IndexerCause[]; rejected: number }>;
  /** Catalogue entries with proofs (`/api/catalog/entries`), at most 100 per call. */
  catalogEntries(at: { bucket: number; index: number }[]): Promise<{ root: Hex; items: EntryWithProof[] }>;
  /** A curator agent's pick leaves with proofs; null when the report is missing or does not match the chain. */
  agentPicks(label: string, epoch: bigint, region: string): Promise<{ picksRoot: Hex; items: PickWithProof[] } | null>;
  /** Org ids of an epoch's ballot (`/api/epochs/:token/:epoch` `optionOrgIds`); null when unknown. Unverified. */
  epochOrgIds(token: Hex, epoch: bigint): Promise<Hex[] | null>;
  /** Tokens with fees, ballots, pin changes or a launch since an epoch (`/api/active-tokens`). */
  activeTokens(sinceEpoch: bigint, sinceTime: bigint): Promise<TokenActivity[]>;
  /**
   * Timestamp (seconds) of the oldest chain's last indexed block (Ponder `/status`), or null when
   * nothing is indexed yet. Tells a caught-up indexer from one that is re-syncing or lagging.
   */
  indexedAt(): Promise<bigint | null>;
}

export interface TokenActivity {
  token: Hex;
  fees: boolean;
  voters: boolean;
  pins: boolean;
  launched: boolean;
  /** A curation skip was requested (the curated ballot must be prepared before it applies). */
  curation: boolean;
}

const ActiveTokensSchema = z.object({
  items: z.array(
    z.object({
      token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase() as Hex),
      fees: z.boolean(),
      voters: z.boolean(),
      pins: z.boolean(),
      launched: z.boolean(),
      curation: z.boolean().default(false),
    }),
  ),
});

/** Ponder `/status`: per chain, the last indexed block. */
const PonderStatusSchema = z.record(z.string(), z.object({ block: z.object({ timestamp: z.number().int().nonnegative() }) }));

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex);
const CatalogEntriesSchema = z.object({
  root: hex32,
  items: z.array(
    z.object({
      bucket: z.number().int().min(0).max(1023),
      index: z.number().int().min(0),
      orgId: hex32,
      proof: z.array(hex32).max(64),
    }),
  ),
});

const EpochOrgIdsSchema = z.object({ optionOrgIds: z.array(hex32).max(32).optional() });

const AgentPicksSchema = z.object({
  picksRoot: hex32,
  items: z
    .array(
      z.object({
        rank: z.number().int().min(0).max(255),
        catalogIndex: z.number().int().min(0).max(2 ** 32 - 1),
        orgId: hex32,
        proof: z.array(hex32).max(64),
      }),
    )
    .max(32),
});

/** Reads the public indexer API (`/api/tokens` paged by cursor, `/api/causes`). */
export function createIndexerClient(baseUrl: string, opts: { fetch?: typeof fetch; maxPages?: number } = {}): IndexerClient {
  const f = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");
  const maxPages = opts.maxPages ?? 1_000;

  async function getJson(path: string): Promise<unknown> {
    const res = await f(`${base}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`indexer ${path.split("?")[0]} returned HTTP ${res.status}`);
    return res.json();
  }

  return {
    async listTokens() {
      const items: IndexerToken[] = [];
      let rejected = 0;
      let cursor: string | null | undefined;
      for (let page = 0; page < maxPages; page++) {
        const q = new URLSearchParams({ limit: "100" });
        if (cursor) q.set("cursor", cursor);
        const p = IndexerTokenPageSchema.parse(await getJson(`/api/tokens?${q}`));
        const r = parseItems(IndexerTokenSchema, p.items);
        items.push(...r.ok);
        rejected += r.rejected;
        cursor = p.nextCursor;
        if (!cursor) return { items, rejected };
      }
      throw new Error("indexer token listing exceeded maxPages");
    },
    async catalogEntries(at) {
      if (at.length === 0) throw new Error("no catalogue entries requested");
      if (at.length > 100) throw new Error("at most 100 catalogue entries per request");
      const q = new URLSearchParams({ at: at.map((e) => `${e.bucket}:${e.index}`).join(",") });
      return CatalogEntriesSchema.parse(await getJson(`/api/catalog/entries?${q}`));
    },
    async agentPicks(label, epoch, region) {
      if (!/^[a-z-]{1,32}$/.test(label) || !/^[a-z-]{1,32}$/.test(region)) throw new Error("invalid agent label or region");
      const path = `/api/agents/${label}/picks/${epoch}/${region}`;
      const res = await f(`${base}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`indexer /api/agents/.../picks returned HTTP ${res.status}`);
      return AgentPicksSchema.parse(await res.json());
    },
    async epochOrgIds(token, epoch) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("invalid token address");
      const path = `/api/epochs/${token.toLowerCase()}/${epoch}`;
      const res = await f(`${base}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`indexer /api/epochs/... returned HTTP ${res.status}`);
      const ids = EpochOrgIdsSchema.parse(await res.json()).optionOrgIds;
      return ids && ids.length > 0 ? ids : null;
    },
    async activeTokens(sinceEpoch, sinceTime) {
      const q = new URLSearchParams({ sinceEpoch: sinceEpoch.toString(), sinceTime: sinceTime.toString() });
      return ActiveTokensSchema.parse(await getJson(`/api/active-tokens?${q}`)).items;
    },
    async indexedAt() {
      const chains = Object.values(PonderStatusSchema.parse(await getJson("/status")));
      if (chains.length === 0) return null;
      return BigInt(Math.min(...chains.map((c) => c.block.timestamp)));
    },
    async listCauses() {
      const p = IndexerCausePageSchema.parse(await getJson("/api/causes"));
      const r = parseItems(IndexerCauseSchema, p.items);
      return { items: r.ok, rejected: r.rejected };
    },
  };
}
