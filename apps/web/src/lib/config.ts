import { getAddress, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { z } from "zod";
import { ANON_NETWORK_IDS, isAnonNetworkId, type AnonNetworkId } from "./anon-networks";
import { siteBase } from "./base";

/**
 * Private RPC (anon-rpc). Every chain read goes through an anonymizing network,
 * so the RPC provider never sees the user's IP address. Requests keyed by the
 * user's address never fall back to a direct connection.
 */
export interface PrivateRpcConfig {
  network: AnonNetworkId;
  /** Override the network's specifier contract, e.g. one you publish yourself. */
  specifier?: Address;
  /** Network-defined worker config passed through to the anon-client, e.g. `{ gateways: [...] }` for tor-js. */
  workerConfig?: unknown;
  /** RPC endpoints reached through the anon network, in failover order. Some providers refuse Tor/mixnet exits. */
  rpcUrls: string[];
  /**
   * Used once, directly (not anonymized), to read the specifier contract on mainnet.
   * It learns only that this IP is loading an anon-rpc worker. Defaults to the first rpcUrl.
   */
  bootstrapRpcUrl?: string;
}

export interface AppConfig {
  chainId: number;
  /** Indexer base URLs in priority order; the client fails over down the list. */
  indexerUrls: string[];
  rpcUrl?: string;
  walletConnectProjectId?: string;
  factoryAddress?: Address;
  /** Block the factory was deployed at; bounds the chain-read log scan. */
  factoryDeployBlock?: bigint;
  vaultAddress?: Address;
  governorAddress?: Address;
  privateRpc: PrivateRpcConfig;
}

function addr(value: string | undefined): Address | undefined {
  return value && isAddress(value) ? getAddress(value) : undefined;
}

function urls(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * Public mainnet RPCs that answered through the Nym mixnet when tested (2026-11-05).
 * Some providers refuse anonymizing-network exits, e.g. Cloudflare-fronted ones (HTTP 525
 * or "Cannot fulfill request"), so keep more than one.
 */
export const DEFAULT_PRIVATE_RPC_URLS = [...mainnet.rpcUrls.default.http, "https://ethereum-rpc.publicnode.com"];

function defaultRpcUrls(rpcUrl: string | undefined, csv: string | undefined): string[] {
  const list = urls(csv);
  if (list.length) return list;
  return rpcUrl ? [rpcUrl, ...DEFAULT_PRIVATE_RPC_URLS] : DEFAULT_PRIVATE_RPC_URLS;
}

/** Build-time defaults. Static property access so Next.js inlines NEXT_PUBLIC_* values. */
export function envDefaults(): AppConfig {
  const block = process.env.NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
  const network = process.env.NEXT_PUBLIC_ANON_RPC_NETWORK;
  return {
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1"),
    indexerUrls: urls(process.env.NEXT_PUBLIC_INDEXER_URLS ?? "http://localhost:42069"),
    rpcUrl,
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined,
    factoryAddress: addr(process.env.NEXT_PUBLIC_FACTORY_ADDRESS),
    factoryDeployBlock: block && /^\d+$/.test(block) ? BigInt(block) : undefined,
    vaultAddress: addr(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
    governorAddress: addr(process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS),
    privateRpc: {
      network: isAnonNetworkId(network) ? network : "nym",
      rpcUrls: defaultRpcUrls(rpcUrl, process.env.NEXT_PUBLIC_PRIVATE_RPC_URLS),
    },
  };
}

const address = z.string().refine(isAddress, "invalid address");
const runtimeSchema = z
  .object({
    chainId: z.number().int().positive(),
    indexerUrls: z.array(z.string().url()).min(1),
    rpcUrl: z.string().url(),
    walletConnectProjectId: z.string(),
    factoryAddress: address,
    factoryDeployBlock: z.number().int().nonnegative(),
    vaultAddress: address,
    governorAddress: address,
    privateRpc: z
      .object({
        network: z.enum(ANON_NETWORK_IDS as [AnonNetworkId, ...AnonNetworkId[]]),
        specifier: address,
        workerConfig: z.unknown(),
        rpcUrls: z.array(z.string().url()).min(1),
        bootstrapRpcUrl: z.string().url(),
      })
      .partial(),
  })
  .partial();

/** Merge a parsed config.json over the defaults. Invalid files are ignored entirely. */
export function mergeRuntimeConfig(defaults: AppConfig, raw: unknown): AppConfig {
  const parsed = runtimeSchema.safeParse(raw);
  if (!parsed.success) return defaults;
  const r = parsed.data;
  return {
    chainId: r.chainId ?? defaults.chainId,
    indexerUrls: r.indexerUrls?.map((u) => u.replace(/\/$/, "")) ?? defaults.indexerUrls,
    rpcUrl: r.rpcUrl ?? defaults.rpcUrl,
    walletConnectProjectId: r.walletConnectProjectId ?? defaults.walletConnectProjectId,
    factoryAddress: addr(r.factoryAddress) ?? defaults.factoryAddress,
    factoryDeployBlock: r.factoryDeployBlock !== undefined ? BigInt(r.factoryDeployBlock) : defaults.factoryDeployBlock,
    vaultAddress: addr(r.vaultAddress) ?? defaults.vaultAddress,
    governorAddress: addr(r.governorAddress) ?? defaults.governorAddress,
    privateRpc: mergePrivateRpc(defaults, r.rpcUrl, r.privateRpc),
  };
}

function mergePrivateRpc(
  defaults: AppConfig,
  rpcUrl: string | undefined,
  r: z.infer<typeof runtimeSchema>["privateRpc"],
): PrivateRpcConfig {
  const d = defaults.privateRpc;
  return {
    network: r?.network ?? d.network,
    specifier: addr(r?.specifier) ?? d.specifier,
    workerConfig: r?.workerConfig ?? d.workerConfig,
    // A runtime rpcUrl without an explicit list goes first, ahead of the public fallbacks.
    rpcUrls: r?.rpcUrls?.map((u) => u.replace(/\/$/, "")) ?? (rpcUrl ? [rpcUrl, ...DEFAULT_PRIVATE_RPC_URLS] : d.rpcUrls),
    bootstrapRpcUrl: r?.bootstrapRpcUrl ?? d.bootstrapRpcUrl,
  };
}

/** Load config.json from next to the page (relative, so it follows the bundle). Never throws. */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  base: string = siteBase(),
): Promise<AppConfig> {
  const defaults = envDefaults();
  try {
    const res = await fetchImpl(`${base}config.json`, { cache: "no-store" });
    if (!res.ok) return defaults;
    return mergeRuntimeConfig(defaults, await res.json());
  } catch {
    return defaults;
  }
}
