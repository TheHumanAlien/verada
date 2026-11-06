import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";
import type { AgentRow, AgentsRepo, CurationRow, StoredReport } from "../src/api/agents";

/** Shared curator-agent fixtures: one hunger agent with a week-12 report for Africa. */
export const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
export const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const leaves: [number, number, Hex][] = [
  [0, 4, h(0xa4)],
  [1, 7, h(0xa7)],
];
export const tree = StandardMerkleTree.of(leaves, ["uint8", "uint32", "bytes32"]);
export const ROOT = tree.root as Hex;
export const REF = h(0xbeef);

export const stored: StoredReport = {
  report: {
    category: "hunger",
    epoch: 12,
    catalogVersion: 1,
    title: "Hunger: week 12",
    intro: "This week",
    generatedAt: "2026-11-09T08:00:00.000Z",
    regions: [
      {
        region: "africa",
        weight: 7000,
        summary: "Drought",
        events: [{ title: "Drought", url: "https://news.example/a", date: "2026-11-05", summary: "" }],
        picks: [
          { orgId: h(0xa4), catalogIndex: 4, name: "Org A4", score: 90, reasons: "On the ground", sources: ["https://news.example/a"] },
          { orgId: h(0xa7), catalogIndex: 7, name: "Org A7", score: 70, reasons: "Food aid", sources: [] },
        ],
        newsletter: "Africa section",
      },
    ],
  },
  regions: [{ region: "africa", regionBit: 0, bucket: 32, picksRoot: ROOT, count: 2, weight: 7000, tree: tree.dump() }],
};

export const agent: AgentRow = {
  categoryBit: 2,
  agentId: 7n,
  label: "hunger",
  signer: a(0x51),
  vault: a(0x7a),
  active: true,
  description: "Hunger curator",
  agentURI: null,
  walletLinked: true,
  registeredAt: 100n,
};
const curation = (root: Hex): CurationRow => ({ bucket: 32, epoch: 12n, categoryBit: 2, regionBit: 0, picksRoot: root, count: 2, weight: 7000, catalogVersion: 1, submittedAt: 200n });

export function repo(root: Hex = ROOT): AgentsRepo {
  const report = { categoryBit: 2, epoch: 12n, catalogVersion: 1, reportRef: REF, submittedAt: 200n, txHash: h(1) };
  return {
    listAgents: async () => [{ agent, totals: { donated: 15_000_000n, donations: 2, given: 5_000_000n, gifts: 1 }, latest: report }],
    getAgentByLabel: async (l) => (l === "hunger" ? agent : null),
    totals: async () => ({ donated: 15_000_000n, donations: 2, given: 5_000_000n, gifts: 1 }),
    reports: async () => [report],
    curations: async () => [curation(root)],
    creditedDonations: async () => [{ id: "d1", donor: a(0xd0), amount: 10_000_000n, credit: true, timestamp: 300n, txHash: h(2) }],
    gifts: async () => [],
  };
}

