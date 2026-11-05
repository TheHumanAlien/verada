import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { siteBase } from "./base";

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

/** Build-time defaults. Static property access so Next.js inlines NEXT_PUBLIC_* values. */
export function envDefaults(): AppConfig {
  const block = process.env.NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK;
  return {
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1"),
    indexerUrls: urls(process.env.NEXT_PUBLIC_INDEXER_URLS ?? "http://localhost:42069"),
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || undefined,
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined,
    factoryAddress: addr(process.env.NEXT_PUBLIC_FACTORY_ADDRESS),
    factoryDeployBlock: block && /^\d+$/.test(block) ? BigInt(block) : undefined,
    vaultAddress: addr(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
    governorAddress: addr(process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS),
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
