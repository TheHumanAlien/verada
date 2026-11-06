import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { entryProof, loadCatalog } from "@verada/cause-catalog";
import { AGENT_CATEGORIES, REGIONS, agentByLabel, agentBySlug, bucketId, regionBySlug } from "@verada/sdk";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { buildReport, canonicalJson, type BuiltReport } from "./build.js";
import { giveCalldata, submitCurationsCalldata } from "./calldata.js";
import { parseReport } from "./report.js";
import { oneClawSigner, type CuratorSigner } from "./signer.js";
import { curatorStatus, rpcReader, toJson, vaultOf } from "./status.js";

const HELP = `verada-curator <command> [options]

  status    read the next epoch, deadlines, catalogue version and the agent's vault from chain (--category)
  pool      list a bucket's catalogue entries (--category <slug|label> --region <slug>)
  template  print an empty report for a category (--category, --epoch, --catalog-version)
  build     validate a report against the catalogue and build the pick trees (--report, --out)
  publish   upload a built report to Swarm through the publisher; prints the reference (--built)
  submit    send CuratorRegistry.submitCurations for a built report (--built, --report-ref)
  give      send AgentVault.give (--category --region --org <orgId> --amount <USDC units> [--vault])

Common: --source <catalogue dir or https base URL> (env CATALOG_SOURCE)
Signing (1Claw): env ONECLAW_AGENT_ID, ONECLAW_API_KEY (a network secret in scheduled tasks), ONECLAW_BASE_URL
Contracts: env CURATOR_REGISTRY_ADDRESS, and for give the vault address (--vault, or CuratorRegistry.agentOf)
Chain reads (status, give without --vault): env ETH_RPC_URL (mainnet; several URLs comma-separated)
Publisher: env PUBLISHER_URL
Add --dry-run to print the transaction instead of sending it.
`;

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    category: { type: "string" },
    region: { type: "string" },
    epoch: { type: "string" },
    "catalog-version": { type: "string" },
    report: { type: "string" },
    built: { type: "string" },
    out: { type: "string", default: "built.json" },
    "report-ref": { type: "string" },
    org: { type: "string" },
    amount: { type: "string" },
    vault: { type: "string" },
    source: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const out = (x: unknown) => process.stdout.write(typeof x === "string" ? `${x}\n` : `${JSON.stringify(x, null, 2)}\n`);
const need = (x: string | undefined, name: string): string => {
  if (!x) throw new Error(`${name} is required`);
  return x;
};
const agentOf = (c: string) => {
  const a = agentBySlug(c) ?? agentByLabel(c);
  if (!a) throw new Error(`no agent for ${c}; one of ${AGENT_CATEGORIES.map((x) => x.ensLabel).join(", ")}`);
  return a;
};
const source = () => need(v.source ?? process.env.CATALOG_SOURCE, "--source or CATALOG_SOURCE");

const registryAddress = () => getAddress(need(process.env.CURATOR_REGISTRY_ADDRESS, "CURATOR_REGISTRY_ADDRESS"));
const reader = () => rpcReader(need(process.env.ETH_RPC_URL, "ETH_RPC_URL"));

function signer(): CuratorSigner {
  return oneClawSigner({
    agentId: need(process.env.ONECLAW_AGENT_ID, "ONECLAW_AGENT_ID"),
    apiKey: process.env.ONECLAW_API_KEY ?? "injected-by-proxy",
    baseUrl: process.env.ONECLAW_BASE_URL,
  });
}

async function readBuilt(path: string): Promise<BuiltReport> {
  return JSON.parse(await readFile(path, "utf8")) as BuiltReport;
}

async function send(to: Address, data: Hex, what: string) {
  if (v["dry-run"]) return out({ dryRun: true, what, to, data });
  out({ what, tx: await signer().send(to, data) });
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || v.help) return out(HELP);
  switch (cmd) {
    case "status": {
      const agent = agentOf(need(v.category, "--category"));
      return out(toJson(await curatorStatus(reader(), registryAddress(), agent)));
    }
    case "pool": {
      const agent = agentOf(need(v.category, "--category"));
      const bucket = bucketId(agent.bit, regionBySlug(need(v.region, "--region")).bit);
      const cat = await loadCatalog(source());
      const byOrg = new Map(cat.orgs.map((o) => [o.orgId, o]));
      const entries = [...cat.tree.entries()]
        .filter(([, [b]]) => b === bucket)
        .map(([, [, index, orgId]]) => {
          const o = byOrg.get(orgId);
          return { catalogIndex: index, orgId, name: o?.name, ein: o?.ein, country: o?.country, nteeCode: o?.nteeCode, categories: o?.categories };
        })
        .sort((a, b) => a.catalogIndex - b.catalogIndex);
      return out({ catalogRoot: cat.meta.root, bucket, count: entries.length, entries });
    }
    case "template": {
      const agent = agentOf(need(v.category, "--category"));
      return out({
        schema: "verada.curation/v1",
        category: agent.slug,
        epoch: Number(need(v.epoch, "--epoch")),
        catalogVersion: Number(need(v["catalog-version"], "--catalog-version")),
        generatedAt: new Date().toISOString(),
        title: `${agent.label}: week ${need(v.epoch, "--epoch")}`,
        intro: "",
        regions: REGIONS.map((r) => ({ region: r.slug, weight: 0, summary: "", events: [], picks: [], newsletter: "" })),
      });
    }
    case "build": {
      const report = parseReport(JSON.parse(await readFile(need(v.report, "--report"), "utf8")));
      const built = buildReport(report, await loadCatalog(source()));
      await writeFile(v.out!, JSON.stringify(built, null, 2));
      return out({ out: v.out, reportHash: built.reportHash, regions: built.regions.map((r) => ({ region: r.region, count: r.count, weight: r.weight, picksRoot: r.picksRoot })) });
    }
    case "publish": {
      const built = await readBuilt(need(v.built, "--built"));
      const body = canonicalJson(built.report);
      const hash = keccak256(toHex(body));
      if (hash !== built.reportHash) throw new Error("built report was modified after build");
      const s = signer();
      const signature = await s.signMessage(hash);
      const base = need(process.env.PUBLISHER_URL, "PUBLISHER_URL").replace(/\/+$/, "");
      const res = await fetch(`${base}/agents/reports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-curator-signature": signature },
        body: JSON.stringify({ report: built.report, regions: built.regions }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`publisher returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return out(await res.json());
    }
    case "submit": {
      const built = await readBuilt(need(v.built, "--built"));
      const ref = need(v["report-ref"], "--report-ref");
      const reportRef = (ref.startsWith("0x") ? ref : `0x${ref}`) as Hex;
      return send(registryAddress(), submitCurationsCalldata(built, reportRef), "submitCurations");
    }
    case "give": {
      const agent = agentOf(need(v.category, "--category"));
      const regionBit = regionBySlug(need(v.region, "--region")).bit;
      const bucket = bucketId(agent.bit, regionBit);
      const orgId = need(v.org, "--org").toLowerCase() as Hex;
      const cat = await loadCatalog(source());
      const entry = [...cat.tree.entries()].find(([, [b, , o]]) => b === bucket && o.toLowerCase() === orgId);
      if (!entry) throw new Error(`${orgId} is not in bucket ${bucket}`);
      const [, [, index]] = entry;
      const proof = entryProof(cat.tree, { bucket, index, orgId });
      const vault = v.vault ? getAddress(v.vault) : await vaultOf(reader(), registryAddress(), agent.bit);
      return send(vault, giveCalldata(regionBit, orgId, index, proof, BigInt(need(v.amount, "--amount"))), "give");
    }
    default:
      out(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
