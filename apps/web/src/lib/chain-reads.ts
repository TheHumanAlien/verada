/** Direct chain reads (viem), used when every indexer URL is unreachable. */
import { createPublicClient, getAbiItem, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { epochGovernorAbi, feeVaultAbi, veradaFactoryAbi, veradaTokenAbi } from "@verada/sdk/abis";
import type { AppConfig } from "./config";
import type { TokenSummary } from "./indexer";

export function createChainClient(cfg: AppConfig): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(cfg.rpcUrl) }) as PublicClient;
}

const tokenCreated = getAbiItem({ abi: veradaFactoryAbi, name: "TokenCreated" });

async function nameAndSymbol(client: PublicClient, token: Address): Promise<{ name: string; symbol: string }> {
  const [name, symbol] = await Promise.all([
    client.readContract({ address: token, abi: veradaTokenAbi, functionName: "name" }),
    client.readContract({ address: token, abi: veradaTokenAbi, functionName: "symbol" }),
  ]);
  return { name, symbol };
}

/** Newest-first token list from factory logs. Needs `factoryAddress`; scan starts at `factoryDeployBlock`. */
export async function chainTokens(client: PublicClient, cfg: AppConfig, limit = 50): Promise<TokenSummary[]> {
  if (!cfg.factoryAddress) throw new Error("Factory address not configured");
  const logs = await client.getLogs({
    address: cfg.factoryAddress,
    event: tokenCreated,
    fromBlock: cfg.factoryDeployBlock ?? 0n,
    toBlock: "latest",
  });
  const recent = logs.slice(-limit).reverse();
  return Promise.all(
    recent.map(async (log) => {
      const { token, creator, feeBps, metadataURI } = log.args;
      const meta = await nameAndSymbol(client, token as Address).catch(() => ({ name: "", symbol: "" }));
      return { address: token as string, creator, feeBps: feeBps === undefined ? undefined : Number(feeBps), metadataURI, ...meta };
    }),
  );
}

export async function chainToken(client: PublicClient, cfg: AppConfig, token: Address): Promise<TokenSummary | null> {
  if (cfg.factoryAddress) {
    const logs = await client.getLogs({
      address: cfg.factoryAddress,
      event: tokenCreated,
      args: { token },
      fromBlock: cfg.factoryDeployBlock ?? 0n,
      toBlock: "latest",
    });
    const log = logs[0];
    if (log) {
      const meta = await nameAndSymbol(client, token).catch(() => ({ name: "", symbol: "" }));
      return { address: token, creator: log.args.creator, feeBps: log.args.feeBps === undefined ? undefined : Number(log.args.feeBps), metadataURI: log.args.metadataURI, ...meta };
    }
    return null;
  }
  return null;
}

export async function chainCurrentEpoch(client: PublicClient, cfg: AppConfig): Promise<bigint> {
  if (!cfg.governorAddress) throw new Error("Governor address not configured");
  return client.readContract({ address: cfg.governorAddress, abi: epochGovernorAbi, functionName: "currentEpoch" });
}

/** Cause pool for a token's epoch, raw USDC units (6 decimals). */
export async function chainCausePool(client: PublicClient, cfg: AppConfig, token: Address, epoch: bigint): Promise<bigint> {
  if (!cfg.vaultAddress) throw new Error("Vault address not configured");
  return client.readContract({ address: cfg.vaultAddress, abi: feeVaultAbi, functionName: "causePoolOf", args: [token, epoch] });
}
