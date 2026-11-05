import { buildCatalog, type HarvestedOrg } from "@verada/cause-catalog";
import { bucketId, pickLeafHash } from "@verada/sdk";
import { curatorRegistryAbi } from "@verada/sdk/abis";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ReportError, buildReport, canonicalJson, pickProof } from "../src/build.js";
import { submitCurationsCalldata } from "../src/calldata.js";
import { parseReport } from "../src/report.js";
import { oneClawSigner } from "../src/signer.js";

const org = (i: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(500000000 + i),
  name: `Org ${i}`,
  description: null,
  nteeCode: "K31",
  country: "KEN",
  state: null,
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});
const { catalog } = buildCatalog([org(1), org(2), org(3), org(4, { country: "IND" })]);
const HA = bucketId(2, 0);
const africa = [...catalog.tree.entries()].filter(([, [b]]) => b === HA).map(([, [, index, orgId]]) => ({ index, orgId }));

const report = (picks = africa.map((e) => ({ orgId: e.orgId, catalogIndex: e.index, name: "x", score: 80, reasons: "Drought relief", sources: ["https://news.example/a"] }))) =>
  parseReport({
    schema: "verada.curation/v1",
    category: "hunger",
    epoch: 12,
    catalogVersion: 1,
    generatedAt: "2026-11-09T08:00:00.000Z",
    title: "Hunger: week 12",
    intro: "",
    regions: [
      { region: "africa", weight: 7000, summary: "Drought in the Horn", events: [{ title: "Drought", url: "https://news.example/a", date: "2026-11-05", summary: "" }], picks, newsletter: "..." },
      { region: "asia", weight: 0, summary: "", events: [], picks: [], newsletter: "" },
    ],
  });

describe("report schema", () => {
  it("rejects duplicates, bad weights and unknown categories", () => {
    const r = report();
    expect(() => parseReport({ ...r, category: "other" })).toThrow();
    expect(() => parseReport({ ...r, regions: [r.regions[0], r.regions[0]] })).toThrow(/duplicate region/);
    expect(() => parseReport({ ...r, regions: [{ ...r.regions[0]!, picks: [r.regions[0]!.picks[0], r.regions[0]!.picks[0]] }] })).toThrow(/duplicate pick/);
    expect(() => parseReport({ ...r, regions: [{ ...r.regions[1]!, weight: 5 }] })).toThrow(/weight 0/);
    expect(() => parseReport({ ...r, regions: [{ ...r.regions[0]!, weight: 10_001 }] })).toThrow();
  });
});

describe("buildReport", () => {
  it("builds roots the contracts accept and proofs for every pick", () => {
    const b = buildReport(report(), catalog);
    expect(b.categoryBit).toBe(2);
    const af = b.regions[0]!;
    expect(af).toMatchObject({ region: "africa", regionBit: 0, bucket: HA, count: 3, weight: 7000 });
    expect(b.regions[1]).toMatchObject({ count: 0, weight: 0, picksRoot: `0x${"0".repeat(64)}` });
    af.tree && b.report.regions[0]!.picks.forEach((p, rank) => {
      const proof = pickProof(af, rank, p.catalogIndex, p.orgId as Hex);
      expect(StandardMerkleTree.verify(af.picksRoot, ["uint8", "uint32", "bytes32"], [rank, p.catalogIndex, p.orgId], proof)).toBe(true);
      // The SDK leaf hash is the contract's.
      const t = StandardMerkleTree.load(af.tree as never);
      expect(t.leafHash([rank, p.catalogIndex, p.orgId])).toBe(pickLeafHash(rank, p.catalogIndex, p.orgId as Hex));
    });
    expect(b.reportHash).toBe(keccak256(toHex(canonicalJson(b.report))));
  });

  it("refuses a pick whose catalogue entry is another org", () => {
    const picks = report().regions[0]!.picks.map((p, i) => (i === 1 ? { ...p, catalogIndex: (p.catalogIndex + 1) % 3 } : p));
    expect(() => buildReport(report(picks), catalog)).toThrow(ReportError);
  });

  it("encodes submitCurations for all regions", () => {
    const b = buildReport(report(), catalog);
    const data = submitCurationsCalldata(b, `0x${"ab".repeat(32)}`);
    const { args } = decodeFunctionData({ abi: curatorRegistryAbi, data });
    expect(args[0]).toBe(2);
    expect(args[1]).toBe(12n);
    expect(args[2]).toBe(1);
    expect((args[4] as readonly { regionBit: number; count: number }[]).map((c) => [c.regionBit, c.count])).toEqual([[0, 3], [1, 0]]);
  });
});

describe("oneClawSigner", () => {
  it("submits through the Intents API on ethereum with simulation, and signs messages", async () => {
    const client = {
      agents: {
        submitTransaction: vi.fn(async () => ({ data: { tx_hash: "0xabc", status: "broadcast" } })),
        sign: vi.fn(async () => ({ data: { from: "0x00000000000000000000000000000000000000a1", signature: "0x5151" } })),
      },
    };
    const s = oneClawSigner({ apiKey: "k", agentId: "agent-1" }, client as never);
    expect(await s.send("0x00000000000000000000000000000000000000c0", "0x1234")).toBe("0xabc");
    expect(client.agents.submitTransaction).toHaveBeenCalledWith("agent-1", { to: "0x00000000000000000000000000000000000000c0", value: "0", chain: "ethereum", data: "0x1234", simulate_first: true });
    expect(await s.signMessage("0x99")).toBe("0x5151");
    expect(await s.address()).toBe("0x00000000000000000000000000000000000000a1");
  });
  it("fails loudly when 1Claw does not broadcast", async () => {
    const client = { agents: { submitTransaction: async () => ({ data: { status: "simulation_failed" } }), sign: async () => ({ data: null, error: { message: "denied" } }) } };
    const s = oneClawSigner({ apiKey: "k", agentId: "a" }, client as never);
    await expect(s.send("0x00000000000000000000000000000000000000c0", "0x")).rejects.toThrow(/simulation_failed/);
    await expect(s.signMessage("0x")).rejects.toThrow(/denied/);
  });
});
