import { buildReport, canonicalJson } from "@verada/curator";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { CuratorChain } from "../src/agents.js";
import { recoverReportSigner } from "../src/agents.js";
import { createApp } from "../src/app.js";
import type { SwarmClient } from "../src/swarm.js";
import { config, REF } from "./helpers.js";

const curator = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const report = {
  schema: "verada.curation/v1",
  category: "hunger",
  epoch: 12,
  catalogVersion: 1,
  generatedAt: "2026-11-09T08:00:00.000Z",
  title: "Hunger: week 12",
  intro: "",
  regions: [
    {
      region: "africa",
      weight: 7000,
      summary: "Drought",
      events: [{ title: "Drought", url: "https://news.example/a", date: "2026-11-05", summary: "" }],
      picks: [
        { orgId: h(0xa4), catalogIndex: 4, name: "Org A4", score: 90, reasons: "On the ground", sources: [] },
        { orgId: h(0xa7), catalogIndex: 7, name: "Org A7", score: 70, reasons: "Food aid", sources: [] },
      ],
      newsletter: "Africa",
    },
  ],
};
const HASH = keccak256(toHex(canonicalJson(report)));

function setup(opts: { agent?: { signer: Address; active: boolean } | null; swarmFails?: boolean } = {}) {
  const uploads: { body: string; name: string }[] = [];
  const swarm: SwarmClient = {
    async upload(body, { name }) {
      if (opts.swarmFails) throw new Error("down");
      uploads.push({ body: new TextDecoder().decode(body), name });
      return REF;
    },
    stamp: async () => {
      throw new Error("unused");
    },
  };
  const agent = opts.agent === undefined ? { signer: curator.address, active: true } : opts.agent;
  const lookups: number[] = [];
  const curators: CuratorChain = {
    agentOf: async (bit) => {
      lookups.push(bit);
      return agent;
    },
  };
  const app = createApp({ config: config(), swarm, curators, log: () => {} });
  const post = (body: unknown, signature?: string) =>
    app.request("/agents/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "x-curator-signature": signature } : {}) },
      body: JSON.stringify(body),
    });
  return { post, uploads, lookups };
}

describe("POST /agents/reports", () => {
  it("uploads a report signed by the category's active signer, with trees it built itself", async () => {
    const { post, uploads, lookups } = setup();
    const sig = await curator.signMessage({ message: { raw: HASH } });
    // A forged tree in the upload is ignored: the publisher rebuilds them from the report.
    const res = await post({ report, regions: [{ region: "africa", tree: { forged: true } }] }, sig);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ reference: REF, reportRef: `0x${REF}`, reportHash: HASH, url: `https://gw.verada.xyz/bzz/${REF}/` });
    expect(lookups).toEqual([2]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.name).toBe("hunger-12.json");
    const stored = JSON.parse(uploads[0]!.body);
    const built = buildReport(report as never, null);
    expect(stored.regions).toEqual(JSON.parse(JSON.stringify(built.regions)));
    expect(body.regions[0]).toMatchObject({ region: "africa", picksRoot: built.regions[0]!.picksRoot, count: 2, weight: 7000 });
  });

  it("accepts a signature over the hash as text (HSM personal_sign of the hex string)", async () => {
    const { post } = setup();
    const sig = await curator.signMessage({ message: HASH });
    expect((await post({ report }, sig)).status).toBe(201);
    expect(await recoverReportSigner(HASH, sig)).toContain(curator.address);
  });

  it("rejects other signers, inactive or unknown agents, and missing signatures", async () => {
    const strangerSig = await stranger.signMessage({ message: { raw: HASH } });
    const goodSig = await curator.signMessage({ message: { raw: HASH } });
    const a = setup();
    expect((await a.post({ report }, strangerSig)).status).toBe(401);
    expect((await a.post({ report })).status).toBe(401);
    expect(a.uploads).toHaveLength(0);
    expect((await setup({ agent: { signer: curator.address, active: false } }).post({ report }, goodSig)).status).toBe(403);
    expect((await setup({ agent: null }).post({ report }, goodSig)).status).toBe(403);
    // A signature over a different report does not carry over.
    const edited = { ...report, title: "edited" };
    expect((await a.post({ report: edited }, goodSig)).status).toBe(401);
  });

  it("validates the report and reports upstream failures", async () => {
    const sig = await curator.signMessage({ message: { raw: HASH } });
    const { post } = setup();
    const bad = await post({ report: { ...report, regions: [{ ...report.regions[0], weight: 20_000 }] } }, sig);
    expect(bad.status).toBe(400);
    expect((await setup({ swarmFails: true }).post({ report }, sig)).status).toBe(502);
  });

  it("answers 503 without the registry", async () => {
    const app = createApp({ config: config(), log: () => {} });
    const res = await app.request("/agents/reports", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
  });
});
