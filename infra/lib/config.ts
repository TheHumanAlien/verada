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
}

/** Environment variable name -> value, exactly as the indexer's readEnv() expects them. */
export type IndexerChainConfig = Readonly<Record<string, string>>;

/** Context key -> indexer environment variable. */
export const INDEXER_CHAIN_KEYS = {
  startBlock: "START_BLOCK",
  factoryAddress: "FACTORY_ADDRESS",
  feeVaultAddress: "FEE_VAULT_ADDRESS",
  causeRegistryAddress: "CAUSE_REGISTRY_ADDRESS",
  epochGovernorAddress: "EPOCH_GOVERNOR_ADDRESS",
  donationDistributorAddress: "DONATION_DISTRIBUTOR_ADDRESS",
} as const;

const ADDRESS_KEYS = new Set<string>(Object.keys(INDEXER_CHAIN_KEYS).filter((k) => k.endsWith("Address")));

const str = (node: Node, key: string): string | undefined => {
  const v = node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

const bool = (node: Node, key: string): boolean => {
  const v = str(node, key);
  if (v === undefined) return false;
  if (v !== "true" && v !== "false") throw new Error(`context "${key}" must be true or false`);
  return v === "true";
};

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function loadCorsOrigins(node: Node, isProd: boolean): string | undefined {
  const raw = str(node, "indexerCorsOrigins");
  if (raw === undefined) {
    if (isProd) {
      throw new Error('prod requires context "indexerCorsOrigins" (comma-separated browser origins, e.g. https://verada.eth.limo).');
    }
    return undefined;
  }
  const origins = raw.split(",").map((o) => o.trim()).filter(Boolean);
  for (const o of origins) {
    if (o === "*") {
      if (isProd) throw new Error('"*" is not allowed in indexerCorsOrigins for prod; list the exact origins');
      continue;
    }
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`indexerCorsOrigins entry "${o}" is not a valid origin`);
    }
    if (u.origin !== o || !/^https?:$/.test(u.protocol)) {
      throw new Error(`indexerCorsOrigins entry "${o}" must be a bare origin like https://host[:port] (no path or trailing slash)`);
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

function loadIndexerChain(node: Node, isProd: boolean): IndexerChainConfig {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, envVar] of Object.entries(INDEXER_CHAIN_KEYS)) {
    const v = str(node, key);
    if (v === undefined) {
      missing.push(key);
      continue;
    }
    if (ADDRESS_KEYS.has(key) && !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error(`context "${key}" must be a 0x-prefixed 20-byte address`);
    }
    if (key === "startBlock" && !/^[1-9]\d*$/.test(v)) {
      throw new Error('context "startBlock" must be a positive integer (the deployment block)');
    }
    out[envVar] = v;
  }
  // The indexer throws on startup if any of these is absent, so a prod synth must not succeed without them.
  if (isProd && missing.length > 0) {
    throw new Error(`prod requires indexer context values: ${missing.join(", ")}. Pass them with -c key=value.`);
  }
  // Non-prod: all-or-nothing, so a half-configured task is never deployed.
  if (missing.length > 0 && missing.length < Object.keys(INDEXER_CHAIN_KEYS).length) {
    throw new Error(`incomplete indexer context values, missing: ${missing.join(", ")}`);
  }
  return out;
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

  const indexerDomainName = str(node, "indexerDomainName")?.toLowerCase();
  const indexerCertificateArn = str(node, "indexerCertificateArn");
  const indexerHostedZoneId = str(node, "indexerHostedZoneId");
  const indexerHostedZoneName = str(node, "indexerHostedZoneName")?.toLowerCase();
  const allowInsecureHttp = bool(node, "allowInsecureHttp");
  if (indexerDomainName && !HOSTNAME.test(indexerDomainName)) throw new Error('context "indexerDomainName" must be a valid hostname');
  if (indexerCertificateArn && !/^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]+$/.test(indexerCertificateArn)) {
    throw new Error('context "indexerCertificateArn" must be an ACM certificate ARN');
  }
  if (Boolean(indexerHostedZoneId) !== Boolean(indexerHostedZoneName)) {
    throw new Error('"indexerHostedZoneId" and "indexerHostedZoneName" must be given together');
  }
  if (indexerHostedZoneName && indexerDomainName && indexerDomainName !== indexerHostedZoneName && !indexerDomainName.endsWith(`.${indexerHostedZoneName}`)) {
    throw new Error('"indexerDomainName" must be inside the hosted zone "indexerHostedZoneName"');
  }
  const httpsEnabled = Boolean(indexerCertificateArn || indexerHostedZoneId);
  if (httpsEnabled && !indexerDomainName) {
    throw new Error('HTTPS needs context "indexerDomainName" (the hostname the certificate covers and browsers call).');
  }
  if (indexerDomainName && !httpsEnabled) {
    throw new Error('"indexerDomainName" needs either "indexerCertificateArn" or "indexerHostedZoneId"+"indexerHostedZoneName".');
  }
  if (allowInsecureHttp && isProd) throw new Error('"allowInsecureHttp" is not permitted for prod');
  if (allowInsecureHttp && httpsEnabled) throw new Error('"allowInsecureHttp" contradicts the HTTPS settings; remove one');
  if (!httpsEnabled && !allowInsecureHttp) {
    throw new Error(
      "The indexer must be served over HTTPS (browsers call it directly). Pass indexerDomainName with indexerCertificateArn, " +
        "or indexerDomainName with indexerHostedZoneId + indexerHostedZoneName" +
        (isProd ? "." : ", or -c allowInsecureHttp=true for a throwaway non-prod environment."),
    );
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
    indexerDomainName,
    indexerCertificateArn,
    indexerHostedZoneId,
    indexerHostedZoneName,
    allowInsecureHttp,
    httpsEnabled,
    indexerCorsOrigins: loadCorsOrigins(node, isProd),
    rpcSecretName: str(node, "rpcSecretName") ?? `verada/${envName}/eth-rpc-url`,
    alarmEmail: str(node, "alarmEmail"),
    indexerImageTag: str(node, "indexerImageTag") ?? "initial",
    indexerDesiredCount,
    // The indexer is a single writer per schema, so scale-out is off unless explicitly requested.
    indexerMaxCount: num(node, "indexerMaxCount", indexerDesiredCount),
    indexerChain: loadIndexerChain(node, isProd),
  };
}
