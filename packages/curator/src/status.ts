import { agentVaultAbi, causeCatalogAbi, curatorRegistryAbi, epochGovernorAbi } from "@verada/sdk/abis";
import { createPublicClient, erc20Abi, fallback, getAddress, http, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";

/** The two chain reads `status` and `give` need; a viem public client in the CLI, a stub in tests. */
export interface ChainReader {
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(): Promise<{ timestamp: bigint }>;
}

/** Read-only mainnet reader over `ETH_RPC_URL` (one URL, or several comma-separated, tried in order). */
export function rpcReader(rpcUrl: string): ChainReader {
  const urls = rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("ETH_RPC_URL is empty");
  const client = createPublicClient({ chain: mainnet, transport: urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u))) });
  return {
    readContract: (a) => client.readContract(a as never) as Promise<unknown>,
    getBlock: () => client.getBlock(),
  };
}

/** `CuratorRegistry.Agent`, as viem decodes the tuple. */
export interface RegistryAgent {
  agentId: bigint;
  signer: Address;
  vault: Address;
  active: boolean;
}

export interface CuratorStatus {
  label: string;
  category: string;
  categoryBit: number;
  contracts: { registry: Address; governor: Address; catalog: Address };
  currentEpoch: bigint;
  /** The only epoch `submitCurations` accepts (`currentEpoch() + 1`). */
  nextEpoch: bigint;
  /** `EpochGovernor.epochStart(nextEpoch)`, ISO 8601 UTC. */
  nextEpochStart: string;
  /** Until the next epoch starts, from the latest block's timestamp (negative once it has started). */
  secondsUntilNextEpoch: bigint;
  /** `epochStart(nextEpoch) + CURATION_GRACE`, ISO 8601 UTC: the keeper waits for curated picks until then. */
  curationGraceEnds: string;
  /** `CauseCatalog.latestVersion()` (0: no catalogue yet) and its root (null for version 0). */
  catalogVersion: number;
  catalogRoot: Hex | null;
  agent: { agentId: bigint; signer: Address; vault: Address; active: boolean; registered: boolean };
  /** Null when the agent is not registered (no vault). */
  vault: {
    address: Address;
    paused: boolean;
    usdc: Address;
    usdcBalance: bigint;
    maxGivePerEpoch: bigint;
    /** `givenIn(currentEpoch)`: gifts count against the current epoch's cap. */
    givenThisEpoch: bigint;
    /** `maxGivePerEpoch - givenThisEpoch`, floored at 0. */
    capRemaining: bigint;
    /** What `give` can still send this epoch: the smaller of capRemaining and the USDC balance (0 when paused). */
    giveRemaining: bigint;
  } | null;
}

type Agent = { ensLabel: string; slug: string; bit: number };

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

/** The agent's registry entry. */
export async function registryAgent(reader: ChainReader, registry: Address, categoryBit: number): Promise<RegistryAgent> {
  const a = (await reader.readContract({ address: registry, abi: curatorRegistryAbi, functionName: "agentOf", args: [categoryBit] })) as RegistryAgent;
  return { agentId: a.agentId, signer: getAddress(a.signer), vault: getAddress(a.vault), active: a.active };
}

/** The agent's vault from `CuratorRegistry.agentOf`; throws when the category has no registered agent. */
export async function vaultOf(reader: ChainReader, registry: Address, categoryBit: number): Promise<Address> {
  const { vault } = await registryAgent(reader, registry, categoryBit);
  if (vault === zeroAddress) throw new Error(`no agent registered for category bit ${categoryBit} in CuratorRegistry ${registry}`);
  return vault;
}

/**
 * Everything a curator run needs from chain before it starts: epochs and deadlines (governor), the
 * latest catalogue version and root (the registry's catalogue), the agent entry and its vault limits.
 * The governor and catalogue come from the registry's `governor()` and `catalog()`.
 */
export async function curatorStatus(reader: ChainReader, registry: Address, agent: Agent): Promise<CuratorStatus> {
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    reader.readContract({ address, abi, functionName, args });
  const [governorRaw, catalogRaw, a] = await Promise.all([
    read(registry, curatorRegistryAbi, "governor") as Promise<Address>,
    read(registry, curatorRegistryAbi, "catalog") as Promise<Address>,
    registryAgent(reader, registry, agent.bit),
  ]);
  const governor = getAddress(governorRaw);
  const catalog = getAddress(catalogRaw);
  if (governor === zeroAddress) throw new Error(`CuratorRegistry ${registry} has no governor set`);

  const [current, grace, version, block] = await Promise.all([
    read(governor, epochGovernorAbi, "currentEpoch") as Promise<bigint>,
    read(governor, epochGovernorAbi, "CURATION_GRACE") as Promise<bigint>,
    read(catalog, causeCatalogAbi, "latestVersion") as Promise<number>,
    reader.getBlock(),
  ]);
  const next = current + 1n;
  const [start, root] = await Promise.all([
    read(governor, epochGovernorAbi, "epochStart", [next]) as Promise<bigint>,
    // rootOf reverts for version 0.
    version === 0 ? Promise.resolve(null) : (read(catalog, causeCatalogAbi, "rootOf", [version]) as Promise<Hex>),
  ]);

  const registered = a.vault !== zeroAddress;
  let vault: CuratorStatus["vault"] = null;
  if (registered) {
    const [paused, cap, given, usdcRaw] = await Promise.all([
      read(a.vault, agentVaultAbi, "paused") as Promise<boolean>,
      read(a.vault, agentVaultAbi, "maxGivePerEpoch") as Promise<bigint>,
      read(a.vault, agentVaultAbi, "givenIn", [current]) as Promise<bigint>,
      read(a.vault, agentVaultAbi, "usdc") as Promise<Address>,
    ]);
    const usdc = getAddress(usdcRaw);
    const balance = (await read(usdc, erc20Abi as Abi, "balanceOf", [a.vault])) as bigint;
    const capRemaining = cap > given ? cap - given : 0n;
    vault = {
      address: a.vault,
      paused,
      usdc,
      usdcBalance: balance,
      maxGivePerEpoch: cap,
      givenThisEpoch: given,
      capRemaining,
      giveRemaining: paused ? 0n : capRemaining < balance ? capRemaining : balance,
    };
  }

  return {
    label: agent.ensLabel,
    category: agent.slug,
    categoryBit: agent.bit,
    contracts: { registry, governor, catalog },
    currentEpoch: current,
    nextEpoch: next,
    nextEpochStart: iso(start),
    secondsUntilNextEpoch: start - block.timestamp,
    curationGraceEnds: iso(start + grace),
    catalogVersion: Number(version),
    catalogRoot: root,
    agent: { ...a, registered },
    vault,
  };
}

/** JSON with bigints as decimal strings. */
export function toJson(x: unknown): string {
  return JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
