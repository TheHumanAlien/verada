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
const optionalAddress = z.preprocess(
  blank,
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
    .transform((s) => getAddress(s.toLowerCase()) as Address)
    .optional(),
);
/** One or more http(s) URLs, comma-separated (tried in order through a viem fallback transport). */
const optionalUrlList = z.preprocess(
  blank,
  z
    .string()
    .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
    .refine((list) => list.length > 0 && list.every((u) => /^https?:\/\/[^\s]+$/.test(u)), "must be http(s) URLs")
    .optional(),
);

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
  /** Tally keeper signer (secret). Only needs ETH for gas. */
  KEEPER_PRIVATE_KEY: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
      .transform((s) => s as Hex)
      .optional(),
  ),
  /** Ethereum RPC URL(s) for the keeper, comma-separated (secret: URLs may carry API keys). */
  ETH_RPC_URL: optionalUrlList,
  KEEPER_ENABLED: flag(false),
  /** Plan, estimate and log keeper transactions without decrypting or sending. */
  KEEPER_DRY_RUN: flag(false),
  KEEPER_MAX_TX_PER_RUN: int(10, 1, 1_000),
  KEEPER_LOOKBACK_EPOCHS: int(4, 1, 52),
  KEEPER_INTERVAL_SECONDS: int(300, 30, 86_400),
  EPOCH_GOVERNOR_ADDRESS: optionalAddress,
  VOTING_SCHEME_ADDRESS: optionalAddress,
  TAKEOVER_GOVERNOR_ADDRESS: optionalAddress,
  /** Token discovery fallback when the indexer is down: `TokenCreated` logs from this factory. */
  FACTORY_ADDRESS: optionalAddress,
  FACTORY_DEPLOY_BLOCK: z.preprocess(blank, z.coerce.bigint().nonnegative().optional()),
  /** Overrides the Zama relayer URL of the chain preset (mainnet). */
  ZAMA_RELAYER_URL: optionalUrl,
  /** Zama relayer API key (secret), sent as the relayer's API-key header. Required on mainnet. */
  ZAMA_RELAYER_API_KEY: optionalString,
  // ---- curator agents
  /** `CuratorRegistry`; `POST /agents/reports` checks report signatures against its signers. */
  CURATOR_REGISTRY_ADDRESS: optionalAddress,
  MAX_REPORT_BYTES: int(512 * 1024, 4 * 1024, 4 * 1024 * 1024),
  // ---- mainnet x402 facilitator (CDP does not settle on Ethereum mainnet)
  X402_FACILITATOR_ENABLED: flag(false),
  /** Bearer token the indexer sends (secret). */
  X402_FACILITATOR_TOKEN: optionalString,
  /** The platform's mainnet treasury: the only payee this facilitator settles for. */
  X402_FACILITATOR_PAY_TO: optionalAddress,
  X402_FACILITATOR_NETWORK: z.preprocess(blank, z.string().regex(/^eip155:\d+$/).default("eip155:1")),
  X402_FACILITATOR_USDC: optionalAddress,
  /** 1Claw agent holding the settlement key (allowlisted to USDC only in its 1Claw policy). */
  X402_ONECLAW_AGENT_ID: optionalString,
  /** 1Claw agent API key (secret). */
  X402_ONECLAW_API_KEY: optionalString,
  ONECLAW_BASE_URL: optionalUrl,
  /** Development and fork tests only: a local settlement key instead of 1Claw (secret). */
  X402_FACILITATOR_PRIVATE_KEY: z.preprocess(
    blank,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
      .transform((s) => s as Hex)
      .optional(),
  ),
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
  keeper: KeeperConfig;
  curatorRegistry?: Address;
  maxReportBytes: number;
  facilitator: FacilitatorConfig;
}

export interface FacilitatorConfig {
  enabled: boolean;
  token?: string;
  payTo?: Address;
  network: string;
  usdc?: Address;
  oneClaw?: { agentId: string; apiKey: string; baseUrl?: string };
  privateKey?: Hex;
}

export interface KeeperConfig {
  enabled: boolean;
  dryRun: boolean;
  privateKey?: Hex;
  rpcUrls: string[];
  epochGovernor?: Address;
  votingScheme?: Address;
  takeoverGovernor?: Address;
  factory?: Address;
  factoryDeployBlock?: bigint;
  maxTxPerRun: number;
  lookbackEpochs: number;
  intervalMs: number;
  zamaRelayerUrl?: string;
  zamaRelayerApiKey?: string;
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
    keeper: {
      enabled: e.KEEPER_ENABLED,
      dryRun: e.KEEPER_DRY_RUN,
      privateKey: e.KEEPER_PRIVATE_KEY,
      rpcUrls: e.ETH_RPC_URL ?? [],
      epochGovernor: e.EPOCH_GOVERNOR_ADDRESS,
      votingScheme: e.VOTING_SCHEME_ADDRESS,
      takeoverGovernor: e.TAKEOVER_GOVERNOR_ADDRESS,
      factory: e.FACTORY_ADDRESS,
      factoryDeployBlock: e.FACTORY_DEPLOY_BLOCK,
      maxTxPerRun: e.KEEPER_MAX_TX_PER_RUN,
      lookbackEpochs: e.KEEPER_LOOKBACK_EPOCHS,
      intervalMs: e.KEEPER_INTERVAL_SECONDS * 1000,
      zamaRelayerUrl: e.ZAMA_RELAYER_URL,
      zamaRelayerApiKey: e.ZAMA_RELAYER_API_KEY,
    },
    curatorRegistry: e.CURATOR_REGISTRY_ADDRESS,
    maxReportBytes: e.MAX_REPORT_BYTES,
    facilitator: {
      enabled: e.X402_FACILITATOR_ENABLED,
      token: e.X402_FACILITATOR_TOKEN,
      payTo: e.X402_FACILITATOR_PAY_TO,
      network: e.X402_FACILITATOR_NETWORK,
      usdc: e.X402_FACILITATOR_USDC,
      oneClaw:
        e.X402_ONECLAW_AGENT_ID && e.X402_ONECLAW_API_KEY
          ? { agentId: e.X402_ONECLAW_AGENT_ID, apiKey: e.X402_ONECLAW_API_KEY, baseUrl: e.ONECLAW_BASE_URL }
          : undefined,
      privateKey: e.X402_FACILITATOR_PRIVATE_KEY,
    },
  };
}
