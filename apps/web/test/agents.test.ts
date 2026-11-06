import { describe, expect, it, vi } from "vitest";
import { IndexerClient } from "@/lib/indexer";
import { agentPath, agentsForFocus, formatUsdc, getAgent, getAgentReport, listAgents, regionPicks, regionReport } from "@/lib/agents";

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const F = (fn: unknown) => fn as typeof fetch;
const client = (fn: (url: string) => Promise<unknown>) => new IndexerClient(["https://idx.test"], { fetchImpl: F(fn) });

const summary = (label: string, categoryBit: number, category: string) => ({
  categoryBit,
  category,
  name: category,
  label,
  ensName: `${label}.agent.varada.eth`,
  agentId: "18446744073709551617",
  signer: "0x00000000000000000000000000000000000000a1",
  vault: "0x00000000000000000000000000000000000000b1",
  active: true,
  description: "Ranks homelessness charities",
  walletLinked: true,
});

describe("listAgents", () => {
  it("parses the list, keeps bigints as strings and sorts by category bit", async () => {
    const fn = vi.fn(async (_url: string) =>
      res({
        items: [
          { ...summary("hunger", 2, "hunger"), totals: null, latest: null },
          {
            ...summary("homeless", 1, "homelessness"),
            totals: { donated: "123456789012345678901", donations: 3, given: "5000000", gifts: 1 },
            latest: { epoch: "42", reportRef: "0xabc", catalogVersion: 2 },
          },
          { label: "broken" },
        ],
      }),
    );
    const agents = await listAgents(client(fn));
    expect(fn.mock.calls[0]?.[0]).toBe("https://idx.test/api/agents");
    expect(agents.map((a) => a.label)).toEqual(["homeless", "hunger"]);
    const [h] = agents;
    expect(h?.agentId).toBe("18446744073709551617");
    expect(h?.totals).toEqual({ donated: "123456789012345678901", donations: 3, given: "5000000", gifts: 1 });
    expect(h?.latest).toEqual({ epoch: "42", reportRef: "0xabc", catalogVersion: 2 });
    expect(agents[1]?.totals).toBeNull();
  });

  it("throws when the indexer has no agents (503)", async () => {
    const fn = vi.fn(async () => res({ error: "agents_unavailable" }, 503));
    await expect(listAgents(client(fn))).rejects.toThrow("503");
  });
});

describe("getAgent", () => {
  const detail = {
    ...summary("homeless", 1, "homelessness"),
    totals: { donated: "10000000", donations: 2, given: "0", gifts: 0 },
    reports: [
      { epoch: "43", reportRef: "0xr43", catalogVersion: 2, submittedAt: "1762300000" },
      { epoch: "42", reportRef: "0xr42", catalogVersion: 2, submittedAt: "1761700000" },
    ],
    latestCurations: [{ regionBit: 0, count: 32, weight: 7000, picksRoot: "0xroot" }],
    donors: [
      { donor: "0x00000000000000000000000000000000000000d1", amount: "5000000", timestamp: "1762300001", txHash: "0xt1" },
      { donor: "0x00000000000000000000000000000000000000d2", amount: "1", credit: false, timestamp: "1", txHash: "0xt2" },
    ],
    gifts: [
      { id: "g1", epoch: "42", regionBit: 7, orgId: "0xorg", org: "0x00000000000000000000000000000000000000e1", amount: "2500000", timestamp: "1762300002", txHash: "0xt3" },
    ],
  };

  it("parses the detail and derives latest from reports[0]", async () => {
    const fn = vi.fn(async (_url: string) => res(detail));
    const a = await getAgent(client(fn), "Homeless");
    expect(fn.mock.calls[0]?.[0]).toBe("https://idx.test/api/agents/homeless");
    expect(a?.latest).toEqual({ epoch: "43", reportRef: "0xr43", catalogVersion: 2 });
    expect(a?.reports[0]).toEqual({ epoch: "43", reportRef: "0xr43", catalogVersion: 2, submittedAt: 1762300000 });
    expect(a?.latestCurations).toEqual([{ regionBit: 0, region: "africa", count: 32, weight: 7000, picksRoot: "0xroot" }]);
    expect(a?.gifts[0]).toMatchObject({ epoch: "42", region: "global", amount: "2500000", timestamp: 1762300002 });
  });

  it("drops the address of any donation not credited on chain", async () => {
    const a = await getAgent(client(async () => res(detail)), "homeless");
    expect(a?.donors.map((d) => d.donor)).toEqual(["0x00000000000000000000000000000000000000d1", null]);
    expect(a?.donors[1]?.amount).toBe("1");
  });

  it("returns null for unknown labels without a request, and on 404", async () => {
    const fn = vi.fn(async () => res({ error: "not_found" }, 404));
    expect(await getAgent(client(fn), "not-an-agent")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(await getAgent(client(fn), "hunger")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

const reportBody = {
  agent: summary("homeless", 1, "homelessness"),
  epoch: "43",
  reportRef: "0xr43",
  catalogVersion: 2,
  title: "Week 43",
  intro: "Intro",
  generatedAt: "2026-11-01T00:00:00Z",
  regions: [
    {
      region: "africa",
      regionBit: 0,
      bucket: 16,
      picksRoot: "0xroot",
      verified: true,
      weight: 7000,
      summary: "Floods",
      events: [{ title: "Flood", url: "https://news.test/a", date: "2026-10-30", summary: "s" }],
      picks: [
        { orgId: "0xo2", catalogIndex: 9, name: "Second", score: 80, reasons: "r", sources: ["https://s.test", 5] },
        { orgId: "0xo1", catalogIndex: 3, name: "First", score: 140, reasons: "r", sources: [] },
      ],
      newsletter: "# Hello",
    },
    { region: "global", regionBit: 7, bucket: 23, picksRoot: null, verified: false, weight: 0, summary: "", events: [], picks: [], newsletter: "" },
  ],
};

describe("getAgentReport", () => {
  it("parses regions and picks (rank from submit order, score clamped)", async () => {
    const fn = vi.fn(async (_url: string) => res(reportBody));
    const r = await getAgentReport(client(fn), "homeless", 43n);
    expect(fn.mock.calls[0]?.[0]).toBe("https://idx.test/api/agents/homeless/reports/43");
    expect(r?.epoch).toBe("43");
    expect(r?.agent.totals).toBeNull();
    const picks = regionPicks(r, "africa");
    expect(picks.map((p) => [p.rank, p.name, p.score])).toEqual([
      [0, "Second", 80],
      [1, "First", 100],
    ]);
    expect(picks[0]?.sources).toEqual(["https://s.test"]);
    expect(regionReport(r, "africa")?.verified).toBe(true);
    expect(regionReport(r, "global")?.picksRoot).toBeNull();
    expect(regionPicks(r, "europe")).toEqual([]);
    expect(regionPicks(null, "africa")).toEqual([]);
  });

  it("returns null on 404 and for invalid epochs", async () => {
    const fn = vi.fn(async () => res({ error: "report_unavailable" }, 404));
    expect(await getAgentReport(client(fn), "homeless", 1)).toBeNull();
    expect(await getAgentReport(client(fn), "homeless", "-1")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("helpers", () => {
  const agents = [
    { label: "disaster", category: "disaster-relief", categoryBit: 0 },
    { label: "homeless", category: "homelessness", categoryBit: 1 },
    { label: "hunger", category: "hunger", categoryBit: 2 },
  ];

  it("agentsForFocus filters by focus category slugs, falling back to the mask", () => {
    expect(agentsForFocus(agents, { categories: ["homelessness", "hunger"], categoryMask: "6" }).map((a) => a.label)).toEqual(["homeless", "hunger"]);
    expect(agentsForFocus(agents, { categories: [], categoryMask: "1" }).map((a) => a.label)).toEqual(["disaster"]);
    expect(agentsForFocus(agents, null)).toEqual([]);
  });

  it("formatUsdc", () => {
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc("1234567890")).toBe("1,234.56");
    expect(formatUsdc(1_500_000n)).toBe("1.5");
    expect(formatUsdc("123456789012345678901")).toBe("123,456,789,012,345.67");
    expect(formatUsdc(1n, 6)).toBe("0.000001");
    expect(formatUsdc("nope")).toBe("0");
  });

  it("agentPath", () => {
    expect(agentPath("homeless")).toBe("/agent/homeless/");
    expect(agentPath("homeless", "north-america")).toBe("/agent/homeless/north-america/");
  });
});
