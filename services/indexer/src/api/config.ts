import { z } from "zod";

const int = (def: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  );

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");
/** A USD amount as a decimal string, e.g. "0.01". */
const usd = (def: string) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, "must be a USD amount like 0.01").default(def),
  );

export type PaidRoute = "rankings" | "history" | "catalog" | "newsletters";

export interface X402Config {
  enabled: boolean;
  base?: { network: string; payTo: string; facilitatorUrl?: string; cdpKeyId?: string; cdpKeySecret?: string };
  mainnet?: { network: string; payTo: string; facilitatorUrl: string; facilitatorToken?: string };
  /** USD decimal strings. */
  prices: Record<PaidRoute, string>;
  mainnetMinPrice: string;
}

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
  /** Swarm gateway for curator reports (`/bzz/<ref>/`). */
  SWARM_GATEWAY_URL: z.string().url().optional(),
  ENS_PARENT_NAME: z.string().default("varada.eth"),
  SEARCH_CACHE_TTL_SECONDS: int(300, 1, 86_400),
  SEARCH_CACHE_MAX_ENTRIES: int(500, 10, 100_000),
  SSE_MAX_CLIENTS: int(500, 1, 100_000),
  SSE_POLL_MS: int(2_000, 100, 60_000),
  SSE_HEARTBEAT_MS: int(15_000, 100, 120_000),
  /** Streams are closed after this long; EventSource reconnects with Last-Event-ID. */
  SSE_MAX_AGE_MS: int(300_000, 100, 3_600_000),
  // ---- x402 paid data routes (/x402/v1/*); all revenue goes to the platform treasuries.
  X402_ENABLED: z.enum(["true", "false", "1", "0", ""]).optional(),
  X402_BASE_PAY_TO: address.optional(),
  X402_MAINNET_PAY_TO: address.optional(),
  /** CAIP-2 ids; override for testnets (e.g. eip155:84532). */
  X402_BASE_NETWORK: z.string().regex(/^eip155:\d+$/).default("eip155:8453"),
  X402_MAINNET_NETWORK: z.string().regex(/^eip155:\d+$/).default("eip155:1"),
  /** Base facilitator; unset uses Coinbase CDP (authenticated with CDP_API_KEY_ID/SECRET). */
  X402_BASE_FACILITATOR_URL: z.string().url().optional(),
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  /** The publisher's self-hosted facilitator; CDP does not settle on Ethereum mainnet. */
  X402_MAINNET_FACILITATOR_URL: z.string().url().optional(),
  X402_MAINNET_FACILITATOR_TOKEN: z.string().optional(),
  X402_PRICE_RANKINGS: usd("0.01"),
  X402_PRICE_HISTORY: usd("0.10"),
  X402_PRICE_CATALOG: usd("0.50"),
  X402_PRICE_NEWSLETTERS: usd("0.02"),
  /** Mainnet prices never go below this, so a settlement's gas is covered. */
  X402_MAINNET_MIN_PRICE: usd("0.50"),
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
  swarmGatewayUrl?: string;
  ensParentName: string;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  sseMaxClients: number;
  ssePollMs: number;
  sseHeartbeatMs: number;
  sseMaxAgeMs: number;
  x402: X402Config;
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
    swarmGatewayUrl: e.SWARM_GATEWAY_URL || undefined,
    ensParentName: e.ENS_PARENT_NAME,
    searchCacheTtlMs: e.SEARCH_CACHE_TTL_SECONDS * 1000,
    searchCacheMaxEntries: e.SEARCH_CACHE_MAX_ENTRIES,
    sseMaxClients: e.SSE_MAX_CLIENTS,
    ssePollMs: e.SSE_POLL_MS,
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    sseMaxAgeMs: e.SSE_MAX_AGE_MS,
    x402: x402Of(e),
  };
}

function x402Of(e: z.infer<typeof EnvSchema>): X402Config {
  const enabled = e.X402_ENABLED === "true" || e.X402_ENABLED === "1";
  const base = e.X402_BASE_PAY_TO
    ? {
        network: e.X402_BASE_NETWORK,
        payTo: e.X402_BASE_PAY_TO,
        facilitatorUrl: e.X402_BASE_FACILITATOR_URL,
        cdpKeyId: e.CDP_API_KEY_ID || undefined,
        cdpKeySecret: e.CDP_API_KEY_SECRET || undefined,
      }
    : undefined;
  if (e.X402_MAINNET_PAY_TO && !e.X402_MAINNET_FACILITATOR_URL) {
    throw new Error("X402_MAINNET_PAY_TO needs X402_MAINNET_FACILITATOR_URL (CDP does not settle on mainnet)");
  }
  const mainnet =
    e.X402_MAINNET_PAY_TO && e.X402_MAINNET_FACILITATOR_URL
      ? {
          network: e.X402_MAINNET_NETWORK,
          payTo: e.X402_MAINNET_PAY_TO,
          facilitatorUrl: e.X402_MAINNET_FACILITATOR_URL,
          facilitatorToken: e.X402_MAINNET_FACILITATOR_TOKEN || undefined,
        }
      : undefined;
  if (enabled && !base && !mainnet) {
    throw new Error("X402_ENABLED needs X402_BASE_PAY_TO or X402_MAINNET_PAY_TO");
  }
  return {
    enabled,
    base,
    mainnet,
    prices: {
      rankings: e.X402_PRICE_RANKINGS,
      history: e.X402_PRICE_HISTORY,
      catalog: e.X402_PRICE_CATALOG,
      newsletters: e.X402_PRICE_NEWSLETTERS,
    },
    mainnetMinPrice: e.X402_MAINNET_MIN_PRICE,
  };
}
