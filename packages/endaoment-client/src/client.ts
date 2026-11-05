import { z } from "zod";
import { MemoryCache, type Cache } from "./cache.js";
import {
  OrgCountsResponseSchema,
  OrgDetailsSchema,
  type OrgCountsResponse,
  OrgSearchResponseSchema,
  type OrgDetails,
  type OrgSearchListing,
} from "./schemas.js";

/** Production API server. Default for all consumers. */
export const PRODUCTION_BASE_URL = "https://api.endaoment.org";
/** Dev (canary) server; data may differ from production. Opt in explicitly via `baseUrl`. */
export const DEV_BASE_URL = "https://api.dev.endaoment.org";
/** Staging (stable) server. */
export const STAGING_BASE_URL = "https://api.staging.endaoment.org";
export const DEFAULT_BASE_URL = PRODUCTION_BASE_URL;
export const MAX_PAGE_SIZE = 25;

export interface SearchParams {
  searchTerm?: string;
  nteeMajorCodes?: string[];
  nteeMinorCodes?: string[];
  /** ISO 3166-1 alpha-3 */
  countries?: string[];
  /** US state codes */
  subdivisions?: string[];
  /** 1..25, default 10 */
  count?: number;
  offset?: number;
}

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  cache?: Cache | null;
  cacheTtlMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: string;
}

export class EndaomentApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EndaomentApiError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const SearchParamsSchema = z.object({
  searchTerm: z.string().optional(),
  nteeMajorCodes: z.array(z.string().min(1)).optional(),
  nteeMinorCodes: z.array(z.string().min(1)).optional(),
  countries: z.array(z.string().length(3)).optional(),
  subdivisions: z.array(z.string().length(2)).optional(),
  count: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).optional(),
});

export function buildSearchQuery(params: SearchParams): string {
  const p = SearchParamsSchema.parse(params);
  const q = new URLSearchParams();
  if (p.searchTerm) q.set("searchTerm", p.searchTerm);
  for (const k of ["nteeMajorCodes", "nteeMinorCodes", "countries", "subdivisions"] as const) {
    const v = p[k];
    if (v && v.length) q.set(k, v.join(","));
  }
  if (p.count !== undefined) q.set("count", String(p.count));
  if (p.offset !== undefined) q.set("offset", String(p.offset));
  return q.toString();
}

export class EndaomentClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly cache: Cache | null;
  private readonly ttl: number;
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiKey?: string;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.cache = opts.cache === undefined ? new MemoryCache() : opts.cache;
    this.ttl = opts.cacheTtlMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelay = opts.retryBaseDelayMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.apiKey = opts.apiKey;
  }

  async searchOrganizations(params: SearchParams = {}): Promise<OrgSearchListing[]> {
    const qs = buildSearchQuery(params);
    const json = await this.getJson(`/v2/orgs/search${qs ? `?${qs}` : ""}`);
    return OrgSearchResponseSchema.parse(json);
  }

  /** Iterate all pages of a search (page size defaults to the maximum). */
  async *searchAll(params: Omit<SearchParams, "offset"> = {}, maxResults = Infinity): AsyncGenerator<OrgSearchListing> {
    const count = params.count ?? MAX_PAGE_SIZE;
    let offset = 0;
    let yielded = 0;
    for (;;) {
      const page = await this.searchOrganizations({ ...params, count, offset });
      for (const org of page) {
        if (yielded >= maxResults) return;
        yielded++;
        yield org;
      }
      if (page.length < count) return;
      offset += count;
    }
  }

  /** Organization counts per NTEE major code (`GET /v1/orgs/counts`). */
  async getCounts(nteeMajorCodes: string[]): Promise<OrgCountsResponse> {
    const codes = z.array(z.string().regex(/^[A-Z]$/)).min(1).parse(nteeMajorCodes);
    const json = await this.getJson(`/v1/orgs/counts?nteeMajorCodes=${codes.join(",")}`);
    return OrgCountsResponseSchema.parse(json);
  }

  /** Resolve by EIN (hyphen optional) or Endaoment organization id. Returns null on 404. */
  async getOrganization(identifier: string): Promise<OrgDetails | null> {
    const id = identifier.trim();
    if (!id) throw new EndaomentApiError("identifier is required");
    try {
      const json = await this.getJson(`/v1/orgs/${encodeURIComponent(id)}`);
      return OrgDetailsSchema.parse(json);
    } catch (e) {
      if (e instanceof EndaomentApiError && e.status === 404) return null;
      throw e;
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const cached = this.cache?.get(path);
    if (cached !== undefined) return cached;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(this.baseUrl + path, { headers });
        if (res.ok) {
          const json: unknown = await res.json();
          this.cache?.set(path, json, this.ttl);
          return json;
        }
        const err = new EndaomentApiError(`Endaoment API ${res.status} for ${path}`, res.status);
        if (!RETRYABLE.has(res.status)) throw err;
        lastErr = err;
        const ra = Number(res.headers.get("retry-after"));
        if (attempt < this.maxRetries) {
          await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.baseDelay * 2 ** attempt);
        }
      } catch (e) {
        if (e instanceof EndaomentApiError && !RETRYABLE.has(e.status ?? 0)) throw e;
        if (e instanceof SyntaxError) throw new EndaomentApiError("invalid JSON from Endaoment API");
        lastErr = e;
        if (attempt < this.maxRetries) await this.sleep(this.baseDelay * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new EndaomentApiError("request failed");
  }
}
