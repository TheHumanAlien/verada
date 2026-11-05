/** Direct chain reads (viem), used when every indexer URL is unreachable. */
import { createPublicClient, getAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { categorySlugs, getTokenAddressByLabel, getTokenTextRecord, isValidLabel, regionSlugs, TOKEN_TEXT_KEYS, tokenLabelhash } from "@verada/sdk";
import {
  epochGovernorAbi,
  feeVaultAbi,
  takeoverGovernorAbi,
  tokenProfileRegistryAbi,
  veradaFactoryAbi,
  veradaTokenAbi,
  zamaVotingSchemeAbi,
} from "@verada/sdk/abis";
import type { AppConfig } from "./config";
import { TAKEOVER_STATES, type EpochDetail, type TakeoverItem, type TokenDetail, type TokenFocus, type TokenProfile, type TokenSummary } from "./indexer";
import type { PrivateRpc } from "./private-rpc";

/** Public-scope client: global data only. For anything keyed by a user's address use createAccountClient. */
export function createChainClient(rpc: PrivateRpc): PublicClient {
  return createPublicClient({ chain: mainnet, transport: rpc.transport({ kind: "public" }) }) as PublicClient;
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

const ZERO32 = `0x${"0".repeat(64)}` as const;
const nz = (v: string) => (v === zeroAddress || v === ZERO32 || v === "0x" ? null : v);

/** Profile from the registry, with text records resolved through ENS (registry `text` as the fallback). */
export async function chainProfile(client: PublicClient, cfg: AppConfig, token: Address): Promise<TokenProfile | null> {
  if (!cfg.profileRegistryAddress) return null;
  const registry = cfg.profileRegistryAddress;
  const p = await client.readContract({ address: registry, abi: tokenProfileRegistryAbi, functionName: "getProfile", args: [token] });
  if (p.labelhash === ZERO32) return null;
  const textRecords: Record<string, string> = {};
  await Promise.all(
    Object.values(TOKEN_TEXT_KEYS).map(async (key) => {
      const value = await getTokenTextRecord(client, p.label, key, cfg.ensParentName).catch(() =>
        client.readContract({ address: registry, abi: tokenProfileRegistryAbi, functionName: "text", args: [token, key] }),
      ).catch(() => null);
      if (value) textRecords[key] = value;
    }),
  );
  return {
    label: p.label,
    labelhash: p.labelhash,
    controller: nz(p.controller),
    editor: nz(p.editor),
    logoRef: nz(p.logoRef),
    contenthash: nz(p.contenthash),
    suppressed: p.suppressed,
    registeredAt: Number(p.registeredAt),
    textRecords,
  };
}

async function chainPins(client: PublicClient, cfg: AppConfig, token: Address): Promise<Hex[] | null> {
  if (!cfg.governorAddress) return null;
  const pins = await client.readContract({ address: cfg.governorAddress, abi: epochGovernorAbi, functionName: "shortlistOf", args: [token] });
  return pins.length ? [...pins] : null;
}

async function chainFocus(client: PublicClient, cfg: AppConfig, token: Address): Promise<TokenFocus | null> {
  if (!cfg.profileRegistryAddress) return null;
  const [categoryMask, regionMask] = await client.readContract({
    address: cfg.profileRegistryAddress,
    abi: tokenProfileRegistryAbi,
    functionName: "focusOf",
    args: [token],
  });
  if (categoryMask === 0n) return null;
  return { categoryMask: categoryMask.toString(), regionMask, categories: categorySlugs(categoryMask), regions: regionSlugs(regionMask) };
}

/** Token, profile, pinned causes and focus from the chain. Null when the token is neither in factory logs nor the registry. */
export async function chainTokenDetail(client: PublicClient, cfg: AppConfig, token: Address): Promise<TokenDetail | null> {
  const [summary, profile, shortlist, focus] = await Promise.all([
    chainToken(client, cfg, token).catch(() => null),
    chainProfile(client, cfg, token).catch(() => null),
    chainPins(client, cfg, token).catch(() => null),
    chainFocus(client, cfg, token).catch(() => null),
  ]);
  if (!summary && !profile) return null;
  const base = summary ?? { address: token, ...(await nameAndSymbol(client, token).catch(() => ({ name: "", symbol: "" }))) };
  return { ...base, label: profile?.label ?? undefined, profile, shortlist, focus };
}

/** Resolves a label: ENS first (Universal Resolver), then the profile registry. */
export async function chainTokenByLabel(client: PublicClient, cfg: AppConfig, label: string): Promise<Address | null> {
  try {
    const viaEns = await getTokenAddressByLabel(client, label, cfg.ensParentName);
    if (viaEns) return viaEns;
  } catch {
    // resolver not reachable or not set up; try the registry
  }
  if (!cfg.profileRegistryAddress) return null;
  const t = await client.readContract({
    address: cfg.profileRegistryAddress,
    abi: tokenProfileRegistryAbi,
    functionName: "tokenByLabelhash",
    args: [tokenLabelhash(label)],
  });
  return t === zeroAddress ? null : t;
}

export type LabelStatus =
  | { kind: "invalid" }
  | { kind: "available" }
  | { kind: "taken"; token: Address }
  | { kind: "reserved"; allowedCreator: Address | null }
  | { kind: "unknown"; reason: string };

/** Whether a label can be claimed. Reads only label-keyed public data; no account is sent anywhere. */
export async function chainLabelStatus(client: PublicClient, cfg: AppConfig, label: string): Promise<LabelStatus> {
  if (!isValidLabel(label)) return { kind: "invalid" };
  if (!cfg.profileRegistryAddress) return { kind: "unknown", reason: "profileRegistryAddress is not configured" };
  const hash = tokenLabelhash(label);
  const [holder, reservation] = await Promise.all([
    client.readContract({ address: cfg.profileRegistryAddress, abi: tokenProfileRegistryAbi, functionName: "tokenByLabelhash", args: [hash] }),
    client.readContract({ address: cfg.profileRegistryAddress, abi: tokenProfileRegistryAbi, functionName: "reservationOf", args: [hash] }),
  ]);
  if (holder !== zeroAddress) return { kind: "taken", token: holder };
  const { reserved, allowedCreator } = reservation;
  if (reserved) return { kind: "reserved", allowedCreator: allowedCreator === zeroAddress ? null : allowedCreator };
  return { kind: "available" };
}

/** Epoch view from the governor and its scheme. */
export async function chainEpochDetail(client: PublicClient, cfg: AppConfig, token: Address, epoch: bigint): Promise<EpochDetail> {
  const governor = cfg.governorAddress;
  if (!governor) throw new Error("Governor address not configured");
  const g = { address: governor, abi: epochGovernorAbi } as const;
  const [opened, closed, finalized, options, snapshot, start, voterCount, prepared, pool] = await Promise.all([
    client.readContract({ ...g, functionName: "isOpened", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "isClosed", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "isFinalized", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "epochOptions", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "snapshotOf", args: [epoch] }),
    client.readContract({ ...g, functionName: "epochStart", args: [epoch] }),
    client.readContract({ ...g, functionName: "voterCount", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "isPrepared", args: [token, epoch] }),
    client.readContract({ ...g, functionName: "poolOf", args: [token, epoch] }),
  ]);
  let poll: EpochDetail["poll"] = null;
  if (opened) {
    const scheme = await client.readContract({ ...g, functionName: "epochScheme", args: [token, epoch] });
    const s = { address: scheme, abi: zamaVotingSchemeAbi } as const;
    const [[isFinal, counts], ballotCount, optionCount, isClosedPoll] = await Promise.all([
      client.readContract({ ...s, functionName: "tallyOf", args: [governor, token, epoch] }),
      client.readContract({ ...s, functionName: "ballotCount", args: [governor, token, epoch] }),
      client.readContract({ ...s, functionName: "optionCountOf", args: [governor, token, epoch] }),
      client.readContract({ ...s, functionName: "isClosed", args: [governor, token, epoch] }),
    ]);
    poll = {
      opened: true,
      closed: isClosedPoll,
      isFinal,
      optionCount,
      counts: isFinal ? counts.map(String) : null,
      ballotCount: Number(ballotCount),
      scheme,
    };
  }
  const winner = finalized ? await client.readContract({ ...g, functionName: "winningCause", args: [token, epoch] }) : null;
  return {
    epoch: epoch.toString(),
    options: [...options],
    poll,
    voterCount: Number(voterCount),
    start: Number(start),
    end: Number(start) + 604_800,
    snapshot: Number(snapshot),
    closed,
    finalized,
    winningCause: winner && nz(winner),
    prepared,
    poolSize: pool[1].toString(),
  };
}

/** The token's active takeover proposal (the chain keeps no per-token history index). */
export async function chainTakeovers(client: PublicClient, cfg: AppConfig, token: Address): Promise<TakeoverItem[]> {
  if (!cfg.takeoverGovernorAddress) return [];
  const g = { address: cfg.takeoverGovernorAddress, abi: takeoverGovernorAbi } as const;
  const id = await client.readContract({ ...g, functionName: "activeProposalOf", args: [token] });
  if (id === 0n) return [];
  const [p, state, closed] = await Promise.all([
    client.readContract({ ...g, functionName: "getProposal", args: [id] }),
    client.readContract({ ...g, functionName: "state", args: [id] }),
    client.readContract({ ...g, functionName: "isClosed", args: [id] }),
  ]);
  return [
    {
      proposalId: id.toString(),
      token: p.token,
      proposer: p.proposer,
      newController: p.newController,
      start: Number(p.start),
      end: Number(p.end),
      executionDeadline: Number(p.executionDeadline),
      snapshot: Number(p.snapshot),
      lookbackSnapshot: Number(p.lookbackSnapshot),
      quorumWeight: p.quorumWeight.toString(),
      circulatingWeight: p.circulatingWeight.toString(),
      forWeight: p.forWeight.toString(),
      againstWeight: p.againstWeight.toString(),
      closed,
      tallied: p.tallied,
      executed: p.executed,
      canceled: p.canceled,
      ballotCount: 0,
      state: TAKEOVER_STATES[state] ?? "Unknown",
    },
  ];
}
