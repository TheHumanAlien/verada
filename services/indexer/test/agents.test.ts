import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import type { AgentsRepo } from "../src/api/agents";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "./api.fixtures";
import { REF, ROOT, a, h, repo, stored } from "./agents.fixtures";

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
