import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { PICK_LEAF_TYPES } from "@verada/sdk";
import type { Hex } from "viem";

/** Read access to the curator agents tables (implemented over Ponder's db and by test fixtures). */
export interface AgentRow {
  categoryBit: number;
  agentId: bigint;
  label: string;
  signer: Hex;
  vault: Hex;
  active: boolean;
  description: string;
  agentURI: string | null;
  walletLinked: boolean;
  registeredAt: bigint;
}

export interface CurationRow {
  bucket: number;
  epoch: bigint;
  categoryBit: number;
  regionBit: number;
  picksRoot: Hex;
  count: number;
  weight: number;
  catalogVersion: number;
  submittedAt: bigint;
}

export interface CurationReportRow {
  categoryBit: number;
  epoch: bigint;
  catalogVersion: number;
  reportRef: Hex;
  submittedAt: bigint;
  txHash: Hex;
}

export interface AgentTotals {
  donated: bigint;
  donations: number;
  given: bigint;
  gifts: number;
}

export interface DonationRow {
  id: string;
  donor: Hex | null;
  amount: bigint;
  credit: boolean;
  timestamp: bigint;
  txHash: Hex;
}

export interface GiftRow {
  id: string;
  epoch: bigint;
  regionBit: number;
  orgId: Hex;
  org: Hex;
  amount: bigint;
  timestamp: bigint;
  txHash: Hex;
}

export interface AgentsRepo {
  listAgents(): Promise<{ agent: AgentRow; totals: AgentTotals | null; latest: CurationReportRow | null }[]>;
  getAgentByLabel(label: string): Promise<AgentRow | null>;
  totals(categoryBit: number): Promise<AgentTotals | null>;
  /** Newest epoch first. */
  reports(categoryBit: number, limit: number): Promise<CurationReportRow[]>;
  curations(categoryBit: number, epoch: bigint): Promise<CurationRow[]>;
  /** Credited donations only (opt-in), newest first. */
  creditedDonations(categoryBit: number, limit: number): Promise<DonationRow[]>;
  gifts(categoryBit: number, limit: number): Promise<GiftRow[]>;
}

/** A published report as the publisher stores it on Swarm (the curator CLI's built output). */
export interface StoredReport {
  report: {
    category: string;
    epoch: number;
    catalogVersion: number;
    title: string;
    intro: string;
    generatedAt: string;
    regions: {
      region: string;
      weight: number;
      summary: string;
      events: { title: string; url: string; date: string; summary: string }[];
      picks: { orgId: Hex; catalogIndex: number; name: string; score: number; reasons: string; sources: string[] }[];
      newsletter: string;
    }[];
  };
  regions: { region: string; regionBit: number; bucket: number; picksRoot: Hex; count: number; weight: number; tree: unknown | null }[];
}

export interface ReportFetcher {
  get(ref: Hex): Promise<StoredReport | null>;
}

/** Fetches reports from a Swarm gateway (`/bzz/<ref>`, as the publisher uploads them), with a bounded in-memory cache. */
export function swarmReportFetcher(gatewayUrl: string | undefined, opts: { fetch?: typeof fetch; maxEntries?: number } = {}): ReportFetcher {
  const f = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const cache = new Map<string, StoredReport>();
  const max = opts.maxEntries ?? 200;
  return {
    async get(ref) {
      if (!gatewayUrl) return null;
      const key = ref.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const res = await f(`${gatewayUrl.replace(/\/+$/, "")}/bzz/${key.slice(2)}/`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as StoredReport;
      if (!body?.report || !Array.isArray(body.regions)) return null;
      cache.set(key, body);
      while (cache.size > max) cache.delete(cache.keys().next().value!);
      return body;
    },
  };
}

/**
 * Report regions with their on-chain curation: a region is `verified` when the tree in the report
 * has the root the agent submitted on chain for that bucket and epoch.
 */
export function verifyReport(stored: StoredReport, onChain: CurationRow[]) {
  return stored.report.regions.map((r) => {
    const built = stored.regions.find((x) => x.region === r.region);
    const chain = built ? onChain.find((c) => c.bucket === built.bucket) : undefined;
    let root: string | null = null;
    if (built?.tree) {
      try {
        root = StandardMerkleTree.load(built.tree as never).root;
      } catch {
        root = null;
      }
    }
    const verified = !!chain && !!built && (built.count === 0 ? chain.count === 0 : root === chain.picksRoot.toLowerCase() && chain.count === r.picks.length);
    return { ...r, regionBit: built?.regionBit ?? null, bucket: built?.bucket ?? null, picksRoot: chain?.picksRoot ?? null, verified };
  });
}

/** Pick leaves with proofs for one region (what `prepareCuratedBallot` needs), or null. */
export function pickProofs(stored: StoredReport, region: string) {
  const built = stored.regions.find((x) => x.region === region);
  if (!built?.tree) return null;
  const tree = StandardMerkleTree.load<[number, number, Hex]>(built.tree as never);
  const items: { rank: number; catalogIndex: number; orgId: Hex; proof: Hex[] }[] = [];
  for (const [i, [rank, catalogIndex, orgId]] of tree.entries()) {
    items.push({ rank: Number(rank), catalogIndex: Number(catalogIndex), orgId, proof: tree.getProof(i) as Hex[] });
  }
  items.sort((a, b) => a.rank - b.rank);
  return { picksRoot: tree.root as Hex, leafTypes: PICK_LEAF_TYPES, items };
}
