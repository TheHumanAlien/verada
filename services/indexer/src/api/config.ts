import { z } from "zod";

const int = (def: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  );

const EnvSchema = z.object({
  /** Comma-separated origins and wildcard-suffix patterns. Empty means any origin (read-only GET). */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /** Token bucket: sustained requests per second per client IP. */
  RATE_LIMIT_RPS: int(5, 1, 10_000),
  /** Token bucket: burst capacity per client IP. */
  RATE_LIMIT_BURST: int(60, 1, 100_000),
  /** Number of trusted reverse-proxy hops (ALB = 1) when reading X-Forwarded-For. */
  TRUST_PROXY_HOPS: int(1, 0, 5),
  MAX_URL_LENGTH: int(2048, 128, 16_384),
  ENDAOMENT_API_URL: z.string().url().optional(),
  ENDAOMENT_API_KEY: z.string().optional(),
  /** Published cause catalogue: a directory or an http(s) base URL. */
  CATALOG_SOURCE: z.string().optional(),
  SEARCH_CACHE_TTL_SECONDS: int(300, 1, 86_400),
  SEARCH_CACHE_MAX_ENTRIES: int(500, 10, 100_000),
  SSE_MAX_CLIENTS: int(500, 1, 100_000),
  SSE_POLL_MS: int(2_000, 100, 60_000),
  SSE_HEARTBEAT_MS: int(15_000, 100, 120_000),
  /** Streams are closed after this long; EventSource reconnects with Last-Event-ID. */
  SSE_MAX_AGE_MS: int(300_000, 100, 3_600_000),
});

export interface ApiConfig {
  corsOrigins: string[];
  rateRps: number;
  rateBurst: number;
  trustProxyHops: number;
  maxUrlLength: number;
  endaomentBaseUrl?: string;
  endaomentApiKey?: string;
  catalogSource?: string;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  sseMaxClients: number;
  ssePollMs: number;
  sseHeartbeatMs: number;
  sseMaxAgeMs: number;
}

export function readApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const e = EnvSchema.parse(env);
  return {
    corsOrigins: (e.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rateRps: e.RATE_LIMIT_RPS,
    rateBurst: e.RATE_LIMIT_BURST,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    maxUrlLength: e.MAX_URL_LENGTH,
    endaomentBaseUrl: e.ENDAOMENT_API_URL,
    endaomentApiKey: e.ENDAOMENT_API_KEY || undefined,
    catalogSource: e.CATALOG_SOURCE || undefined,
    searchCacheTtlMs: e.SEARCH_CACHE_TTL_SECONDS * 1000,
    searchCacheMaxEntries: e.SEARCH_CACHE_MAX_ENTRIES,
    sseMaxClients: e.SSE_MAX_CLIENTS,
    ssePollMs: e.SSE_POLL_MS,
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    sseMaxAgeMs: e.SSE_MAX_AGE_MS,
  };
}
