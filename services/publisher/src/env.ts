import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const blank = (v: unknown) => (v === undefined || v === "" ? undefined : v);

const int = (def: number, min: number, max: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def));

const flag = (def: boolean) =>
  z.preprocess(
    blank,
    z
      .enum(["true", "false", "1", "0", "yes", "no"])
      .default(def ? "true" : "false")
      .transform((v) => v === "true" || v === "1" || v === "yes"),
  );

const optionalUrl = z.preprocess(
  blank,
  z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), "must be http(s)")
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
);
const optionalString = z.preprocess(blank, z.string().optional());

const EnvSchema = z.object({
  PORT: int(42070, 1, 65_535),
  /** Swarm gateway (ethersphere/swarm-gateway) base URL uploads go through. */
  BEE_GATEWAY_URL: optionalUrl,
  /** Sent verbatim as the `Authorization` header; the gateway compares it to its AUTH_SECRET. */
  BEE_GATEWAY_AUTH_SECRET: optionalString,
  /**
   * Base URL that serves the Bee `GET /stamps/{batchId}` endpoint. swarm-gateway does not proxy
   * `/stamps`, so point this at the Bee API (internal). Defaults to BEE_GATEWAY_URL.
   */
  BEE_STAMPS_URL: optionalUrl,
  SWARM_BATCH_ID: z.preprocess(
    blank,
    z
      .string()
      .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex batch id")
      .transform((s) => s.replace(/^0x/, "").toLowerCase())
      .optional(),
  ),
  /** Gateway browsers read from (e.g. https://gw.verada.xyz); used to build returned URLs. */
  PUBLIC_GATEWAY_URL: optionalUrl,
  /** Public indexer API base URL (the mirror job reads /api/tokens and /api/causes). */
  INDEXER_URL: optionalUrl,
  /** Ethereum chain id the mirrored records belong to. */
  CHAIN_ID: int(1, 1, 2 ** 31 - 1),
  ARKIV_CHAIN: z.preprocess(blank, z.enum(["rabdi", "localhost"]).default("rabdi")),
  ARKIV_ACCESS_KEY: optionalString,
  ARKIV_PRIVATE_KEY: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
      .transform((s) => s as Hex)
      .optional(),
  ),
  ARKIV_RPC_URL: optionalUrl,
  ARKIV_ENABLED: flag(false),
  /** Plan and log Arkiv writes without sending them. */
  ARKIV_DRY_RUN: flag(false),
  /** Comma-separated origins and `*.` wildcard-suffix patterns. Empty means any origin. */
  CORS_ALLOWED_ORIGINS: optionalString,
  RATE_LIMIT_RPS: int(1, 1, 10_000),
  RATE_LIMIT_BURST: int(20, 1, 100_000),
  TRUST_PROXY_HOPS: int(1, 0, 5),
  MAX_LOGO_BYTES: int(2 * 1024 * 1024, 1024, 16 * 1024 * 1024),
  MAX_METADATA_BYTES: int(64 * 1024, 1024, 1024 * 1024),
  JOB_INTERVAL_SECONDS: int(60, 5, 86_400),
  /** Passed through by GET /site when set. */
  SITE_FEED_OWNER: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .transform((s) => getAddress(s.toLowerCase()) as Address)
      .optional(),
  ),
  SITE_FEED_MANIFEST: z.preprocess(blank, z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).optional()),
  /** Reserved for the tally keeper (not used yet). */
  KEEPER_PRIVATE_KEY: optionalString,
  ETH_RPC_URL: optionalString,
});

export type PublisherEnv = z.infer<typeof EnvSchema>;

export interface PublisherConfig {
  port: number;
  swarm: {
    gatewayUrl?: string;
    authSecret?: string;
    stampsUrl?: string;
    batchId?: string;
    publicGatewayUrl?: string;
  };
  indexerUrl?: string;
  chainId: number;
  arkiv: {
    enabled: boolean;
    dryRun: boolean;
    chain: "rabdi" | "localhost";
    accessKey?: string;
    privateKey?: Hex;
    rpcUrl?: string;
  };
  corsOrigins: string[];
  rateRps: number;
  rateBurst: number;
  trustProxyHops: number;
  maxLogoBytes: number;
  maxMetadataBytes: number;
  jobIntervalMs: number;
  siteFeed: { owner?: Address; manifest?: string };
}

/** Reads and validates publisher configuration. Throws with the offending variable names only. */
export function readConfig(env: Record<string, string | undefined>): PublisherConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    // Never echo values: some of these are secrets.
    const names = [...new Set(r.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid publisher environment: ${names}`);
  }
  const e = r.data;
  return {
    port: e.PORT,
    swarm: {
      gatewayUrl: e.BEE_GATEWAY_URL,
      authSecret: e.BEE_GATEWAY_AUTH_SECRET,
      stampsUrl: e.BEE_STAMPS_URL ?? e.BEE_GATEWAY_URL,
      batchId: e.SWARM_BATCH_ID,
      publicGatewayUrl: e.PUBLIC_GATEWAY_URL,
    },
    indexerUrl: e.INDEXER_URL,
    chainId: e.CHAIN_ID,
    arkiv: {
      enabled: e.ARKIV_ENABLED,
      dryRun: e.ARKIV_DRY_RUN,
      chain: e.ARKIV_CHAIN,
      accessKey: e.ARKIV_ACCESS_KEY,
      privateKey: e.ARKIV_PRIVATE_KEY,
      rpcUrl: e.ARKIV_RPC_URL,
    },
    corsOrigins: (e.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rateRps: e.RATE_LIMIT_RPS,
    rateBurst: e.RATE_LIMIT_BURST,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    maxLogoBytes: e.MAX_LOGO_BYTES,
    maxMetadataBytes: e.MAX_METADATA_BYTES,
    jobIntervalMs: e.JOB_INTERVAL_SECONDS * 1000,
    siteFeed: {
      owner: e.SITE_FEED_OWNER,
      manifest: e.SITE_FEED_MANIFEST?.replace(/^0x/, "").toLowerCase(),
    },
  };
}
