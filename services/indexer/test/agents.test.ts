import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import type { AgentRow, AgentsRepo, CurationRow, StoredReport } from "../src/api/agents";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "./api.fixtures";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const leaves: [number, number, Hex][] = [
  [0, 4, h(0xa4)],
  [1, 7, h(0xa7)],
];
const tree = StandardMerkleTree.of(leaves, ["uint8", "uint32", "bytes32"]);
const ROOT = tree.root as Hex;
const REF = h(0xbeef);

const stored: StoredReport = {
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

const agent: AgentRow = {
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

function repo(root: Hex = ROOT): AgentsRepo {
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

const mk = (agents?: AgentsRepo) => {
  const config = readApiConfig({});
  const r = fixtureRepo();
  return createApi({
    repo: r,
    search: { search: async () => [] },
    config,
    bus: new ActivityBus(() => r.listActivity({ limit: 100 }), 10_000),
    agents,
    reports: { get: async (ref) => (ref === REF ? stored : null) },
  });
};
const json = async (app: ReturnType<typeof createApi>, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};

describe("agents API", () => {
  it("lists agents with their ENS names, totals and latest report", async () => {
    const { body } = await json(mk(repo()), "/api/agents");
    expect(body.items[0]).toMatchObject({ label: "hunger", ensName: "hunger.agent.varada.eth", category: "hunger", agentId: "7", vault: a(0x7a) });
    expect(body.items[0].totals.donated).toBe("15000000");
    expect(body.items[0].latest.reportRef).toBe(REF);
  });

  it("shows an agent with opt-in donors only and its report archive", async () => {
    const { status, body } = await json(mk(repo()), "/api/agents/hunger");
    expect(status).toBe(200);
    expect(body.donors).toEqual([{ donor: a(0xd0), amount: "10000000", timestamp: "300", txHash: h(2) }]);
    expect(body.reports[0]).toMatchObject({ epoch: "12", reportRef: REF });
    expect(body.latestCurations[0]).toMatchObject({ regionBit: 0, count: 2, weight: 7000 });
    expect((await json(mk(repo()), "/api/agents/nope")).status).toBe(400);
    expect((await json(mk(repo()), "/api/agents/homeless")).status).toBe(404);
  });

  it("serves the report with regions verified against the on-chain roots", async () => {
    const ok = (await json(mk(repo()), "/api/agents/hunger/reports/12")).body;
    expect(ok.title).toBe("Hunger: week 12");
    expect(ok.regions[0]).toMatchObject({ region: "africa", verified: true, picksRoot: ROOT });
    const bad = (await json(mk(repo(h(0x99))), "/api/agents/hunger/reports/12")).body;
    expect(bad.regions[0].verified).toBe(false);
    expect((await json(mk(repo()), "/api/agents/hunger/reports/13")).status).toBe(404);
  });

  it("serves pick leaves with proofs for the keeper, only when the root matches the chain", async () => {
    const { body } = await json(mk(repo()), "/api/agents/hunger/picks/12/africa");
    expect(body.picksRoot).toBe(ROOT);
    expect(body.items.map((i: { rank: number }) => i.rank)).toEqual([0, 1]);
    for (const i of body.items) {
      expect(StandardMerkleTree.verify(ROOT, ["uint8", "uint32", "bytes32"], [i.rank, i.catalogIndex, i.orgId], i.proof)).toBe(true);
    }
    expect((await json(mk(repo(h(0x99))), "/api/agents/hunger/picks/12/africa")).body.error).toBe("report_mismatch");
    expect((await json(mk(repo()), "/api/agents/hunger/picks/12/mars")).status).toBe(400);
  });

  it("answers 503 without the agents tables", async () => {
    expect((await json(mk(undefined), "/api/agents")).status).toBe(503);
  });
});
