import type { Hex } from "viem";
import { z } from "zod";
import type { EntryWithProof } from "./keeper/ballot.js";
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
}

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
    async listCauses() {
      const p = IndexerCausePageSchema.parse(await getJson("/api/causes"));
      const r = parseItems(IndexerCauseSchema, p.items);
      return { items: r.ok, rejected: r.rejected };
    },
  };
}
