import { Node } from "constructs";

export type DbMode = "rds" | "aurora";

export interface VeradaConfig {
  readonly account: string;
  readonly region: string;
  readonly envName: string;
  readonly isProd: boolean;
  /** "rds": single-AZ RDS Postgres t4g.micro (dev default). "aurora": Aurora Serverless v2 (prod default). */
  readonly dbMode: DbMode;
  /** When true the VPC gets NAT gateways + interface endpoints and tasks run in private subnets. */
  readonly privateEgress: boolean;
  /** NAT gateway count, only used when privateEgress is true. */
  readonly natGateways: number;
  /** Public hostname of the indexer API (required: browsers call it over HTTPS). */
  readonly indexerDomainName?: string;
  /** Existing ACM certificate ARN (same region as the ALB) covering indexerDomainName. */
  readonly indexerCertificateArn?: string;
  /** Optional Route53 hosted zone; with indexerDomainName the stack creates the cert (DNS-validated) and the alias record. */
  readonly indexerHostedZoneId?: string;
  readonly indexerHostedZoneName?: string;
  /** Non-prod escape hatch: serve the ALB over plain HTTP. Never allowed in prod. */
  readonly allowInsecureHttp: boolean;
  /** True when the ALB terminates TLS (certificate ARN or hosted-zone-issued certificate). */
  readonly httpsEnabled: boolean;
  /** Comma-separated browser origins allowed by the indexer (CORS_ALLOWED_ORIGINS, read by services/indexer). */
  readonly indexerCorsOrigins?: string;
  /** Where the indexer loads the published cause catalogue from (directory or http(s) base URL). */
  readonly indexerCatalogSource?: string;
  /** Name of an existing Secrets Manager secret holding the Ethereum mainnet RPC URL (plain string). */
  readonly rpcSecretName: string;
  /** Optional email subscribed to alarm notifications. */
  readonly alarmEmail?: string;
  /** Image tag of the indexer image in the stack's ECR repository. */
  readonly indexerImageTag: string;
  readonly indexerDesiredCount: number;
  readonly indexerMaxCount: number;
  /** On-chain settings the indexer needs (deployment block and contract addresses). Required in prod. */
  readonly indexerChain: IndexerChainConfig;
  /** Context keys of required indexer settings that are absent (non-prod only; prod synth fails instead). */
  readonly indexerChainMissing: readonly string[];
  /** Indexer API settings beyond the chain: curator report gateway, ENS parent, x402 paid routes. */
  readonly indexerApi: IndexerApiConfig;
  /** Bee light node + Swarm gateway (SwarmStack). */
  readonly swarm: SwarmConfig;
  /** Feed publisher service (PublisherStack). */
  readonly publisher: PublisherConfig;
}

/** Public ALB TLS settings shared by every internet-facing service. */
export interface TlsConfig {
  readonly domainName?: string;
  readonly certificateArn?: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
  /** True when the ALB terminates TLS (certificate ARN or hosted-zone-issued certificate). */
  readonly httpsEnabled: boolean;
}

export interface SwarmConfig extends TlsConfig {
  /** Secrets Manager JSON secret with fields password, gnosisRpcUrl, gatewayAuthSecret. */
  readonly secretName: string;
  readonly beeImage: string;
  readonly gatewayImage: string;
  /** uid/gid the Bee image runs as; owns the EFS access point root. */
  readonly beeUid: number;
  readonly beeGid: number;
  /** 0 or 1: the Bee data directory is a single-writer volume. */
  readonly desiredCount: number;
  readonly postageDepth: number;
  /** PLUR per chunk, kept as a decimal string (exceeds 32-bit, stays within 2^53). */
  readonly postageAmount: string;
  readonly postageKeepAlive: boolean;
}

export interface PublisherConfig extends TlsConfig {
  /** Secrets Manager JSON secret, see PUBLISHER_SECRET_FIELDS. */
  readonly secretName: string;
  readonly imageTag: string;
  readonly desiredCount: number;
  /** Base URL of the Swarm gateway the publisher uploads through (BEE_GATEWAY_URL, PUBLIC_GATEWAY_URL). */
  readonly gatewayUrl?: string;
  /** Public indexer URL (INDEXER_URL). */
  readonly indexerUrl?: string;
  readonly arkivChain: string;
  readonly arkivEnabled: boolean;
  readonly corsOrigins?: string;
  readonly jobIntervalSeconds: number;
  /** ARKIV_DRY_RUN: plan and log Arkiv writes without sending them. */
  readonly arkivDryRun: boolean;
  /** KEEPER_ENABLED: schedule the tally keeper. Off by default. */
  readonly keeperEnabled: boolean;
  /** KEEPER_DRY_RUN: the keeper logs what it would submit and sends nothing. On by default. */
  readonly keeperDryRun: boolean;
  /** ZAMA_RELAYER_URL: relayer the keeper requests public decryption through. */
  readonly zamaRelayerUrl?: string;
  /** SITE_FEED_OWNER / SITE_FEED_MANIFEST: passed through by GET /site. */
  readonly siteFeedOwner?: string;
  readonly siteFeedManifest?: string;
  /** MAX_REPORT_BYTES: body limit of POST /agents/reports (service default when unset). */
  readonly maxReportBytes?: number;
  /** Mainnet x402 facilitator (X402_FACILITATOR_*), off by default. */
  readonly facilitator: PublisherFacilitatorConfig;
}

export interface PublisherFacilitatorConfig {
  /** X402_FACILITATOR_ENABLED; adds the PUBLISHER_FACILITATOR_SECRET_FIELDS secret references. */
  readonly enabled: boolean;
  /** X402_FACILITATOR_PAY_TO: the only payee it settles for (defaults to x402MainnetPayTo). */
  readonly payTo?: string;
  /** X402_FACILITATOR_NETWORK (defaults to x402MainnetNetwork, then the service default eip155:1). */
  readonly network?: string;
  /** X402_FACILITATOR_USDC (service default: mainnet USDC). */
  readonly usdc?: string;
  /** ONECLAW_BASE_URL (service default: the 1Claw API). */
  readonly oneClawBaseUrl?: string;
}

export interface IndexerApiConfig {
  /** SWARM_GATEWAY_URL: where the indexer reads curator reports; the publisher's gateway URL. */
  readonly swarmGatewayUrl?: string;
  /** ENS_PARENT_NAME (service default: varada.eth). */
  readonly ensParentName?: string;
  readonly x402: IndexerX402Config;
}

export interface IndexerX402Config {
  /** X402_ENABLED. When false no other X402_* variable and no secret reference is passed. */
  readonly enabled: boolean;
  /** Validated X402_* variables (non-secret), only when enabled. */
  readonly environment: Readonly<Record<string, string>>;
  /** Secrets Manager JSON secret (verada/<env>/indexer) holding the CDP keys and the facilitator token. */
  readonly secretName: string;
  /** Task variable -> field of secretName, only the ones this configuration needs. */
  readonly secretFields: Readonly<Record<string, string>>;
}

/** Ethereum chain the contracts live on (CHAIN_ID for the publisher). */
export const CHAIN_ID = 1;

/** Indexer chain values (environment variable names) the publisher also receives. */
export const PUBLISHER_CHAIN_ENV = [
  "EPOCH_GOVERNOR_ADDRESS",
  "VOTING_SCHEME_ADDRESS",
  "TAKEOVER_GOVERNOR_ADDRESS",
  "FACTORY_ADDRESS",
  "START_BLOCK",
  "CURATOR_REGISTRY_ADDRESS",
] as const;

/** Publisher task environment variable -> field of the verada/<env>/publisher JSON secret. */
export const PUBLISHER_SECRET_FIELDS = {
  BEE_GATEWAY_AUTH_SECRET: "beeGatewayAuthSecret",
  SWARM_BATCH_ID: "swarmBatchId",
  ARKIV_ACCESS_KEY: "arkivAccessKey",
  ARKIV_PRIVATE_KEY: "arkivPrivateKey",
  KEEPER_PRIVATE_KEY: "keeperPrivateKey",
  ETH_RPC_URL: "ethRpcUrl",
} as const;

/** Added to the publisher secret references only with keeperEnabled=true. */
export const PUBLISHER_KEEPER_SECRET_FIELDS = {
  ZAMA_RELAYER_API_KEY: "zamaRelayerApiKey",
} as const;

/** Added to the publisher secret references only with x402FacilitatorEnabled=true. */
export const PUBLISHER_FACILITATOR_SECRET_FIELDS = {
  X402_FACILITATOR_TOKEN: "x402FacilitatorToken",
  X402_ONECLAW_AGENT_ID: "x402OneClawAgentId",
  X402_ONECLAW_API_KEY: "x402OneClawApiKey",
} as const;

/**
 * Indexer task environment variable -> field of the verada/<env>/indexer JSON secret. Referenced only
 * with x402Enabled=true: the CDP keys when Base payments settle through CDP (x402BasePayTo without
 * x402BaseFacilitatorUrl), the token when mainnet payments are on (x402MainnetPayTo). The token must be
 * the publisher secret's x402FacilitatorToken.
 */
export const INDEXER_X402_SECRET_FIELDS = {
  CDP_API_KEY_ID: "cdpApiKeyId",
  CDP_API_KEY_SECRET: "cdpApiKeySecret",
  X402_MAINNET_FACILITATOR_TOKEN: "x402FacilitatorToken",
} as const;

/** Context key -> indexer price variable (USD decimal strings; service defaults when unset). */
export const INDEXER_X402_PRICE_KEYS = {
  x402PriceRankings: "X402_PRICE_RANKINGS",
  x402PriceHistory: "X402_PRICE_HISTORY",
  x402PriceCatalog: "X402_PRICE_CATALOG",
  x402PriceNewsletters: "X402_PRICE_NEWSLETTERS",
  x402MainnetMinPrice: "X402_MAINNET_MIN_PRICE",
} as const;

/** Bee/gateway task environment variable -> field of the verada/<env>/bee JSON secret. */
export const BEE_SECRET_FIELDS = {
  BEE_PASSWORD: "password",
  BEE_BLOCKCHAIN_RPC_ENDPOINT: "gnosisRpcUrl",
  AUTH_SECRET: "gatewayAuthSecret",
} as const;

/** Environment variable name -> value, exactly as the indexer's readEnv() expects them. */
export type IndexerChainConfig = Readonly<Record<string, string>>;

/** Context key -> indexer environment variable. Core set: all-or-nothing outside prod. */
export const INDEXER_CHAIN_KEYS = {
  startBlock: "START_BLOCK",
  factoryAddress: "FACTORY_ADDRESS",
  feeVaultAddress: "FEE_VAULT_ADDRESS",
  causeRegistryAddress: "CAUSE_REGISTRY_ADDRESS",
  epochGovernorAddress: "EPOCH_GOVERNOR_ADDRESS",
  donationDistributorAddress: "DONATION_DISTRIBUTOR_ADDRESS",
} as const;

/**
 * Also required by the indexer's readEnv(). Required in prod; outside prod a missing value is a synth
 * warning (the task would exit at start-up) so older dummy-context synths keep working.
 */
export const INDEXER_LATE_CHAIN_KEYS = {
  feeConsolidatorAddress: "FEE_CONSOLIDATOR_ADDRESS",
  quoteRegistryAddress: "QUOTE_REGISTRY_ADDRESS",
} as const;

/** Optional addresses the indexer will read; default to the zero address when not given. */
export const INDEXER_OPTIONAL_CHAIN_KEYS = {
  tokenRegistryAddress: "TOKEN_REGISTRY_ADDRESS",
  takeoverGovernorAddress: "TAKEOVER_GOVERNOR_ADDRESS",
  votingSchemeAddress: "VOTING_SCHEME_ADDRESS",
  causeCatalogAddress: "CAUSE_CATALOG_ADDRESS",
  curatorRegistryAddress: "CURATOR_REGISTRY_ADDRESS",
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const str = (node: Node, key: string): string | undefined => {
  const v = node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

const bool = (node: Node, key: string, dflt = false): boolean => {
  const v = str(node, key);
  if (v === undefined) return dflt;
  if (v !== "true" && v !== "false") throw new Error(`context "${key}" must be true or false`);
  return v === "true";
};

function loadCatalogSource(node: Node): string | undefined {
  const v = str(node, "indexerCatalogSource");
  if (v === undefined) return undefined;
  if (!/^https:\/\/[^\s]+$/.test(v)) throw new Error('"indexerCatalogSource" must be an https:// URL (the catalogue collection on a Swarm gateway)');
  return v.replace(/\/+$/, "");
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function loadCorsOrigins(node: Node, isProd: boolean, key = "indexerCorsOrigins", fallback?: string): string | undefined {
  const raw = str(node, key) ?? fallback;
  if (raw === undefined) {
    if (isProd) {
      throw new Error(`prod requires context "${key}" (comma-separated browser origins, e.g. https://varada.eth.limo).`);
    }
    return undefined;
  }
  const origins = raw.split(",").map((o) => o.trim()).filter(Boolean);
  for (const o of origins) {
    if (o === "*") {
      if (isProd) throw new Error(`"*" is not allowed in ${key} for prod; list the exact origins`);
      continue;
    }
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`${key} entry "${o}" is not a valid origin`);
    }
    if (u.origin !== o || !/^https?:$/.test(u.protocol)) {
      throw new Error(`${key} entry "${o}" must be a bare origin like https://host[:port] (no path or trailing slash)`);
    }
  }
  return origins.join(",");
}

const num = (node: Node, key: string, dflt: number): number => {
  const v = str(node, key);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`context "${key}" must be a non-negative integer`);
  return n;
};

function chainValue(key: string, v: string): string {
  if (key.endsWith("Address") && !ADDRESS.test(v)) {
    throw new Error(`context "${key}" must be a 0x-prefixed 20-byte address`);
  }
  if (key === "startBlock" && !/^[1-9]\d*$/.test(v)) {
    throw new Error('context "startBlock" must be a positive integer (the deployment block)');
  }
  return v;
}

function loadIndexerChain(node: Node, isProd: boolean): { chain: IndexerChainConfig; missing: string[] } {
  const out: Record<string, string> = {};
  const missingCore: string[] = [];
  const missingLate: string[] = [];
  for (const [key, envVar] of Object.entries(INDEXER_CHAIN_KEYS)) {
    const v = str(node, key);
    if (v === undefined) missingCore.push(key);
    else out[envVar] = chainValue(key, v);
  }
  for (const [key, envVar] of Object.entries(INDEXER_LATE_CHAIN_KEYS)) {
    const v = str(node, key);
    if (v === undefined) missingLate.push(key);
    else out[envVar] = chainValue(key, v);
  }
  const missing = [...missingCore, ...missingLate];
  // The indexer throws on startup if any of these is absent, so a prod synth must not succeed without them.
  if (isProd && missing.length > 0) {
    throw new Error(`prod requires indexer context values: ${missing.join(", ")}. Pass them with -c key=value.`);
  }
  // Non-prod: the core set is all-or-nothing, so a half-configured task is never deployed by accident.
  if (missingCore.length > 0 && missingCore.length < Object.keys(INDEXER_CHAIN_KEYS).length) {
    throw new Error(`incomplete indexer context values, missing: ${missingCore.join(", ")}`);
  }
  for (const [key, envVar] of Object.entries(INDEXER_OPTIONAL_CHAIN_KEYS)) {
    const v = str(node, key);
    out[envVar] = v === undefined ? ZERO_ADDRESS : chainValue(key, v);
  }
  return { chain: out, missing };
}

const ACM_ARN = /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]+$/;

/**
 * TLS settings for one public ALB, read from <prefix>DomainName, <prefix>CertificateArn and
 * <prefix>HostedZoneId/<prefix>HostedZoneName. Without them the service is HTTP-only, which is
 * allowed only outside prod with allowInsecureHttp=true.
 */
function loadTls(node: Node, prefix: string, label: string, why: string, isProd: boolean, allowInsecureHttp: boolean): TlsConfig {
  const domainName = str(node, `${prefix}DomainName`)?.toLowerCase();
  const certificateArn = str(node, `${prefix}CertificateArn`);
  const hostedZoneId = str(node, `${prefix}HostedZoneId`);
  const hostedZoneName = str(node, `${prefix}HostedZoneName`)?.toLowerCase();
  if (domainName && !HOSTNAME.test(domainName)) throw new Error(`context "${prefix}DomainName" must be a valid hostname`);
  if (certificateArn && !ACM_ARN.test(certificateArn)) {
    throw new Error(`context "${prefix}CertificateArn" must be an ACM certificate ARN`);
  }
  if (Boolean(hostedZoneId) !== Boolean(hostedZoneName)) {
    throw new Error(`"${prefix}HostedZoneId" and "${prefix}HostedZoneName" must be given together`);
  }
  if (hostedZoneName && domainName && domainName !== hostedZoneName && !domainName.endsWith(`.${hostedZoneName}`)) {
    throw new Error(`"${prefix}DomainName" must be inside the hosted zone "${prefix}HostedZoneName"`);
  }
  const httpsEnabled = Boolean(certificateArn || hostedZoneId);
  if (httpsEnabled && !domainName) {
    throw new Error(`HTTPS needs context "${prefix}DomainName" (the hostname the certificate covers and clients call).`);
  }
  if (domainName && !httpsEnabled) {
    throw new Error(`"${prefix}DomainName" needs either "${prefix}CertificateArn" or "${prefix}HostedZoneId"+"${prefix}HostedZoneName".`);
  }
  if (!httpsEnabled && !allowInsecureHttp) {
    throw new Error(
      `The ${label} must be served over HTTPS (${why}). Pass ${prefix}DomainName with ${prefix}CertificateArn, ` +
        `or ${prefix}DomainName with ${prefix}HostedZoneId + ${prefix}HostedZoneName` +
        (isProd ? "." : ", or -c allowInsecureHttp=true for a throwaway non-prod environment."),
    );
  }
  return { domainName, certificateArn, hostedZoneId, hostedZoneName, httpsEnabled };
}

function httpUrl(node: Node, key: string): string | undefined {
  const v = str(node, key);
  if (v === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`context "${key}" must be an absolute http(s) URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`context "${key}" must be an absolute http(s) URL`);
  return v.replace(/\/+$/, "");
}

function optAddress(node: Node, key: string): string | undefined {
  const v = str(node, key);
  if (v !== undefined && !ADDRESS.test(v)) throw new Error(`context "${key}" must be a 0x-prefixed 20-byte address`);
  return v;
}

const CAIP2_EVM = /^eip155:\d+$/;

function network(node: Node, key: string): string | undefined {
  const v = str(node, key);
  if (v !== undefined && !CAIP2_EVM.test(v)) throw new Error(`context "${key}" must be a CAIP-2 EVM network like eip155:1`);
  return v;
}

/** An http(s) URL; https only in prod. */
function serviceUrl(node: Node, key: string, isProd: boolean): string | undefined {
  const v = httpUrl(node, key);
  if (isProd && v?.startsWith("http:")) throw new Error(`prod requires an https "${key}"`);
  return v;
}

const sameAddress = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

function loadFacilitator(node: Node, isProd: boolean): PublisherFacilitatorConfig {
  const enabled = bool(node, "x402FacilitatorEnabled");
  const mainnetPayTo = optAddress(node, "x402MainnetPayTo");
  const payTo = optAddress(node, "x402FacilitatorPayTo") ?? mainnetPayTo;
  const mainnetNetwork = network(node, "x402MainnetNetwork");
  const net = network(node, "x402FacilitatorNetwork") ?? mainnetNetwork;
  const usdc = optAddress(node, "x402FacilitatorUsdc");
  const oneClawBaseUrl = serviceUrl(node, "oneClawBaseUrl", isProd);
  if (enabled && !payTo) {
    throw new Error('"x402FacilitatorEnabled" needs context "x402FacilitatorPayTo" (or "x402MainnetPayTo"): the only payee it settles for');
  }
  // The facilitator refuses every payment to another payee or network, so a mismatch would fail them all.
  if (mainnetPayTo && payTo && !sameAddress(mainnetPayTo, payTo)) {
    throw new Error('"x402FacilitatorPayTo" must equal "x402MainnetPayTo" (the facilitator settles only for that payee)');
  }
  if (mainnetNetwork && net && mainnetNetwork !== net) {
    throw new Error('"x402FacilitatorNetwork" must equal "x402MainnetNetwork"');
  }
  return { enabled, payTo, network: net, usdc, oneClawBaseUrl };
}

function loadIndexerApi(node: Node, envName: string, isProd: boolean, publisher: PublisherConfig): IndexerApiConfig {
  const ensParentName = str(node, "ensParentName")?.toLowerCase();
  if (ensParentName && !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/.test(ensParentName)) {
    throw new Error('context "ensParentName" must be an ENS name ending in .eth, like varada.eth');
  }
  const enabled = bool(node, "x402Enabled");
  const basePayTo = optAddress(node, "x402BasePayTo");
  const mainnetPayTo = optAddress(node, "x402MainnetPayTo");
  const baseNetwork = network(node, "x402BaseNetwork");
  const mainnetNetwork = network(node, "x402MainnetNetwork");
  const baseFacilitatorUrl = serviceUrl(node, "x402BaseFacilitatorUrl", isProd);
  // Default: this environment's own publisher facilitator, when it is on and has an HTTPS hostname.
  const ownFacilitator =
    publisher.facilitator.enabled && publisher.httpsEnabled && publisher.domainName ? `https://${publisher.domainName}/x402` : undefined;
  const mainnetFacilitatorUrl = serviceUrl(node, "x402MainnetFacilitatorUrl", isProd) ?? ownFacilitator;
  const prices: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(INDEXER_X402_PRICE_KEYS)) {
    const v = str(node, key);
    if (v === undefined) continue;
    if (!/^\d{1,6}(\.\d{1,6})?$/.test(v)) throw new Error(`context "${key}" must be a USD amount like 0.01`);
    prices[envVar] = v;
  }
  if (mainnetPayTo && !mainnetFacilitatorUrl) {
    throw new Error(
      '"x402MainnetPayTo" needs "x402MainnetFacilitatorUrl", or "x402FacilitatorEnabled=true" with an HTTPS publisher domain (CDP does not settle on mainnet)',
    );
  }
  if (enabled && !basePayTo && !mainnetPayTo) throw new Error('"x402Enabled" needs "x402BasePayTo" or "x402MainnetPayTo"');

  const environment: Record<string, string> = {};
  const secretFields: Record<string, string> = {};
  if (enabled) {
    if (basePayTo) {
      environment.X402_BASE_PAY_TO = basePayTo;
      if (baseNetwork) environment.X402_BASE_NETWORK = baseNetwork;
      if (baseFacilitatorUrl) environment.X402_BASE_FACILITATOR_URL = baseFacilitatorUrl;
      else {
        secretFields.CDP_API_KEY_ID = INDEXER_X402_SECRET_FIELDS.CDP_API_KEY_ID;
        secretFields.CDP_API_KEY_SECRET = INDEXER_X402_SECRET_FIELDS.CDP_API_KEY_SECRET;
      }
    }
    if (mainnetPayTo && mainnetFacilitatorUrl) {
      environment.X402_MAINNET_PAY_TO = mainnetPayTo;
      environment.X402_MAINNET_FACILITATOR_URL = mainnetFacilitatorUrl;
      if (mainnetNetwork) environment.X402_MAINNET_NETWORK = mainnetNetwork;
      secretFields.X402_MAINNET_FACILITATOR_TOKEN = INDEXER_X402_SECRET_FIELDS.X402_MAINNET_FACILITATOR_TOKEN;
    }
    Object.assign(environment, prices);
  }
  return {
    swarmGatewayUrl: publisher.gatewayUrl,
    ensParentName,
    x402: {
      enabled,
      environment,
      secretName: str(node, "indexerSecretName") ?? `verada/${envName}/indexer`,
      secretFields,
    },
  };
}

const IMAGE = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$/;

function image(node: Node, key: string, dflt: string): string {
  const v = str(node, key) ?? dflt;
  if (!IMAGE.test(v)) throw new Error(`context "${key}" must be an image reference like repo/name:tag`);
  return v;
}

function loadSwarm(node: Node, envName: string, isProd: boolean, allowInsecureHttp: boolean): SwarmConfig {
  const tls = loadTls(node, "swarm", "Swarm gateway", "the publisher and browsers fetch site content from it", isProd, allowInsecureHttp);
  const desiredCount = num(node, "swarmDesiredCount", 1);
  if (desiredCount > 1) throw new Error('context "swarmDesiredCount" must be 0 or 1 (the Bee data directory is single-writer)');
  const postageAmount = str(node, "swarmPostageAmount") ?? "1270000000000";
  if (!/^[1-9]\d*$/.test(postageAmount) || !Number.isSafeInteger(Number(postageAmount))) {
    throw new Error('context "swarmPostageAmount" must be a positive integer below 2^53');
  }
  const postageDepth = num(node, "swarmPostageDepth", 22);
  if (postageDepth < 17 || postageDepth > 255) throw new Error('context "swarmPostageDepth" must be between 17 and 255');
  return {
    ...tls,
    secretName: str(node, "beeSecretName") ?? `verada/${envName}/bee`,
    beeImage: image(node, "beeImage", "ethersphere/bee:2.8.3"),
    gatewayImage: image(node, "swarmGatewayImage", "ethersphere/swarm-gateway:0.4.0"),
    beeUid: num(node, "beeUid", 999),
    beeGid: num(node, "beeGid", 999),
    desiredCount,
    postageDepth,
    postageAmount,
    postageKeepAlive: bool(node, "swarmPostageKeepAlive", true),
  };
}

function loadPublisher(
  node: Node,
  envName: string,
  isProd: boolean,
  allowInsecureHttp: boolean,
  swarm: SwarmConfig,
  indexer: { domainName?: string; httpsEnabled: boolean; corsOrigins?: string },
): PublisherConfig {
  const tls = loadTls(node, "publisher", "publisher", "the app calls it from the browser", isProd, allowInsecureHttp);
  const gatewayUrl = httpUrl(node, "swarmGatewayUrl") ?? (swarm.domainName ? `https://${swarm.domainName}` : undefined);
  const indexerUrl = httpUrl(node, "indexerPublicUrl") ?? (indexer.domainName && indexer.httpsEnabled ? `https://${indexer.domainName}` : undefined);
  const arkivChain = str(node, "arkivChain") ?? "rabdi";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(arkivChain)) throw new Error('context "arkivChain" must be a lowercase chain name');
  const jobIntervalSeconds = num(node, "publisherJobIntervalSeconds", 60);
  if (jobIntervalSeconds < 5 || jobIntervalSeconds > 86_400) {
    throw new Error('context "publisherJobIntervalSeconds" must be between 5 and 86400');
  }
  const zamaRelayerUrl = httpUrl(node, "zamaRelayerUrl");
  if (isProd && zamaRelayerUrl?.startsWith("http:")) throw new Error('prod requires an https "zamaRelayerUrl"');
  const siteFeedOwner = str(node, "siteFeedOwner");
  if (siteFeedOwner && !ADDRESS.test(siteFeedOwner)) throw new Error('context "siteFeedOwner" must be a 0x-prefixed 20-byte address');
  const siteFeedManifest = str(node, "siteFeedManifest");
  if (siteFeedManifest && !/^(0x)?[0-9a-fA-F]{64}$/.test(siteFeedManifest)) {
    throw new Error('context "siteFeedManifest" must be a 32-byte hex Swarm reference');
  }
  const publisherDesiredCount = num(node, "publisherDesiredCount", 1);
  if (publisherDesiredCount > 1) throw new Error('context "publisherDesiredCount" must be 0 or 1 (it signs keeper transactions)');
  if (isProd && gatewayUrl?.startsWith("http:")) throw new Error('prod requires an https "swarmGatewayUrl"');
  if (isProd && indexerUrl?.startsWith("http:")) throw new Error('prod requires an https "indexerPublicUrl"');
  const maxReportBytes = str(node, "maxReportBytes") === undefined ? undefined : num(node, "maxReportBytes", 0);
  if (maxReportBytes !== undefined && (maxReportBytes < 4096 || maxReportBytes > 4 * 1024 * 1024)) {
    throw new Error('context "maxReportBytes" must be between 4096 and 4194304');
  }
  return {
    ...tls,
    secretName: str(node, "publisherSecretName") ?? `verada/${envName}/publisher`,
    imageTag: str(node, "publisherImageTag") ?? "initial",
    desiredCount: publisherDesiredCount,
    gatewayUrl,
    indexerUrl,
    arkivChain,
    arkivEnabled: bool(node, "arkivEnabled"),
    // Same convention as the indexer: bare origins, CORS_ALLOWED_ORIGINS; defaults to the indexer's list.
    corsOrigins: loadCorsOrigins(node, isProd, "publisherCorsOrigins", indexer.corsOrigins),
    jobIntervalSeconds,
    arkivDryRun: bool(node, "arkivDryRun", true),
    keeperEnabled: bool(node, "keeperEnabled"),
    keeperDryRun: bool(node, "keeperDryRun", true),
    zamaRelayerUrl,
    siteFeedOwner,
    siteFeedManifest,
    maxReportBytes,
    facilitator: loadFacilitator(node, isProd),
  };
}

/**
 * Read deployment configuration from CDK context (-c key=value or cdk.context.json).
 * account and region have no defaults on purpose: nothing is hardcoded in source.
 */
export function loadConfig(node: Node): VeradaConfig {
  const account = str(node, "account") ?? process.env.CDK_DEFAULT_ACCOUNT;
  const region = str(node, "region") ?? process.env.CDK_DEFAULT_REGION;
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error('Missing or invalid context "account" (12-digit AWS account id). Pass -c account=<id>.');
  }
  if (!region) throw new Error('Missing context "region". Pass -c region=<region>.');
  // Optional: seed the AZ lookup so synth needs no AWS credentials (same effect as a cached
  // cdk.context.json entry). Without it, the first synth with credentials performs the lookup.
  const azs = str(node, "availabilityZones");
  if (azs) {
    const list = azs.split(",").map((z) => z.trim()).filter(Boolean);
    if (list.length < 2) throw new Error('context "availabilityZones" needs at least two comma-separated zones');
    node.setContext(`availability-zones:account=${account}:region=${region}`, list);
  }
  const envName = str(node, "envName") ?? "dev";
  if (!/^[a-z][a-z0-9-]{1,14}$/.test(envName)) {
    throw new Error('context "envName" must match ^[a-z][a-z0-9-]{1,14}$');
  }
  const isProd = envName === "prod";

  const dbModeRaw = str(node, "dbMode") ?? (isProd ? "aurora" : "rds");
  if (dbModeRaw !== "rds" && dbModeRaw !== "aurora") throw new Error('context "dbMode" must be "rds" or "aurora"');

  const allowInsecureHttp = bool(node, "allowInsecureHttp");
  if (allowInsecureHttp && isProd) throw new Error('"allowInsecureHttp" is not permitted for prod');
  const indexerTls = loadTls(node, "indexer", "indexer", "browsers call it directly", isProd, allowInsecureHttp);
  // For the indexer the flag is all-or-nothing; the Swarm gateway and publisher may mix (HTTP only where
  // they have no TLS settings) so a dev environment can bring up HTTPS one service at a time.
  if (allowInsecureHttp && indexerTls.httpsEnabled) throw new Error('"allowInsecureHttp" contradicts the HTTPS settings; remove one');
  const indexerCorsOrigins = loadCorsOrigins(node, isProd);
  const chain = loadIndexerChain(node, isProd);
  const swarm = loadSwarm(node, envName, isProd, allowInsecureHttp);
  const publisher = loadPublisher(node, envName, isProd, allowInsecureHttp, swarm, {
    domainName: indexerTls.domainName,
    httpsEnabled: indexerTls.httpsEnabled,
    corsOrigins: indexerCorsOrigins,
  });
  const indexerApi = loadIndexerApi(node, envName, isProd, publisher);

  if (publisher.keeperEnabled) {
    const need = { epochGovernorAddress: "EPOCH_GOVERNOR_ADDRESS", votingSchemeAddress: "VOTING_SCHEME_ADDRESS" };
    const absent = Object.entries(need)
      .filter(([, envVar]) => !chain.chain[envVar] || chain.chain[envVar] === ZERO_ADDRESS)
      .map(([key]) => key);
    if (absent.length > 0) throw new Error(`"keeperEnabled" needs context values: ${absent.join(", ")}`);
  }

  const indexerDesiredCount = num(node, "indexerDesiredCount", 1);
  return {
    account,
    region,
    envName,
    isProd,
    dbMode: dbModeRaw,
    privateEgress: bool(node, "privateEgress"),
    natGateways: num(node, "natGateways", 1),
    indexerDomainName: indexerTls.domainName,
    indexerCertificateArn: indexerTls.certificateArn,
    indexerHostedZoneId: indexerTls.hostedZoneId,
    indexerHostedZoneName: indexerTls.hostedZoneName,
    allowInsecureHttp,
    httpsEnabled: indexerTls.httpsEnabled,
    indexerCorsOrigins,
    indexerCatalogSource: loadCatalogSource(node),
    rpcSecretName: str(node, "rpcSecretName") ?? `verada/${envName}/eth-rpc-url`,
    alarmEmail: str(node, "alarmEmail"),
    indexerImageTag: str(node, "indexerImageTag") ?? "initial",
    indexerDesiredCount,
    // The indexer is a single writer per schema, so scale-out is off unless explicitly requested.
    indexerMaxCount: num(node, "indexerMaxCount", indexerDesiredCount),
    indexerChain: chain.chain,
    indexerChainMissing: chain.missing,
    indexerApi,
    swarm,
    publisher,
  };
}
