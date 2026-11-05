import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import {
  contenthashToSwarmReference,
  lookupResolver,
  normalizeReference,
  readContenthash,
  setContenthashCalldata,
  swarmReferenceToContenthash,
} from "./contenthash.js";
import { sizeReport, validateExport } from "./validate.js";
import { estimateStamp } from "./stamp.js";

const HELP = `verada-publish <command> [options]

  build            run the web static export and validate out/
  validate         validate an existing export directory
  upload           upload out/ to a Bee node (dry-run unless --execute)
  ens-contenthash  swarm reference -> contenthash + setContenthash calldata (never signs or sends)
  verify           check an ENS name's contenthash equals a swarm reference

Common: --dir <out dir> (default apps/web/out)
build:    --cmd "<command>" (default "pnpm --filter @verada/web build")
upload:   --execute  --pin  --index-document index.html  --error-document 404.html
          --ttl-days 30  --price-per-block 24000  --block-time 5
          env: BEE_URL (default http://localhost:1633), BEE_POSTAGE_BATCH_ID (required with --execute)
ens-contenthash: --ref <hex|bzz://hex> --name <ens name> [--rpc <url>|env ETH_RPC_URL] [--resolver <addr>]
verify:   --name <ens name> --ref <hex> --rpc <url>|env ETH_RPC_URL [--gateway <https://...>]
`;

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "apps/web/out" },
    cmd: { type: "string", default: "pnpm --filter @verada/web build" },
    execute: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    pin: { type: "boolean", default: false },
    "index-document": { type: "string", default: "index.html" },
    "error-document": { type: "string" },
    "ttl-days": { type: "string", default: "30" },
    "price-per-block": { type: "string", default: "24000" },
    "block-time": { type: "string", default: "5" },
    ref: { type: "string" },
    name: { type: "string" },
    rpc: { type: "string" },
    resolver: { type: "string" },
    gateway: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function validateAndReport(dir: string): void {
  const r = validateExport(dir);
  console.log(sizeReport(r));
  for (const w of r.warnings) console.warn(`warn: ${w}`);
  if (r.errors.length) {
    for (const e of r.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.log("export OK");
}

function rpcClient() {
  const url = v.rpc ?? process.env.ETH_RPC_URL;
  if (!url) fail("an RPC url is required (--rpc or ETH_RPC_URL)");
  return createPublicClient({ transport: http(url) });
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || v.help) return void console.log(HELP);
  const dir = resolve(v.dir!);

  switch (cmd) {
    case "build": {
      const [bin, ...args] = v.cmd!.split(/\s+/);
      console.log(`running: ${v.cmd}`);
      const r = spawnSync(bin!, args, { stdio: "inherit" });
      if (r.status !== 0) fail("build failed");
      return validateAndReport(dir);
    }
    case "validate":
      return validateAndReport(dir);
    case "upload": {
      const rep = validateExport(dir);
      if (rep.errors.length) {
        rep.errors.forEach((e) => console.error(`error: ${e}`));
        fail("export is invalid; fix before uploading");
      }
      const est = estimateStamp(rep.files, {
        ttlDays: Number(v["ttl-days"]),
        pricePerBlock: Number(v["price-per-block"]),
        blockTime: Number(v["block-time"]),
      });
      console.log(sizeReport(rep));
      console.log(
        `estimate (approximate, price assumed ${v["price-per-block"]} PLUR/chunk/block):\n` +
          `  chunks ~${est.chunks}, upload ~${est.uploadBytes} bytes\n` +
          `  stamp depth needed: ${est.depth} (effective capacity ~${est.effectiveBytes} bytes)\n` +
          `  TTL ${est.ttlDays} days -> amount ${est.amountPlur} PLUR, cost ~${est.costBzz} xBZZ`,
      );
      if (!v.execute || v["dry-run"]) {
        console.log("dry-run: nothing uploaded. Re-run with --execute to upload.");
        return;
      }
      const batchId = process.env.BEE_POSTAGE_BATCH_ID;
      if (!batchId) fail("BEE_POSTAGE_BATCH_ID is required with --execute");
      const beeUrl = process.env.BEE_URL ?? "http://localhost:1633";
      const { uploadDirectory } = await import("./upload.js");
      const ref = await uploadDirectory({
        beeUrl,
        batchId,
        dir,
        indexDocument: v["index-document"]!,
        errorDocument: v["error-document"],
        pin: v.pin!,
      });
      console.log(`swarm reference: ${ref}`);
      console.log(`bzz://${ref}`);
      console.log(`next: verada-publish ens-contenthash --ref ${ref} --name <your.eth>`);
      return;
    }
    case "ens-contenthash": {
      if (!v.ref) fail("--ref is required");
      const ref = normalizeReference(v.ref);
      console.log(`reference:   ${ref}`);
      console.log(`contenthash: ${swarmReferenceToContenthash(ref)}`);
      if (!v.name) return;
      const c = setContenthashCalldata(v.name, ref);
      console.log(`name:        ${c.name}`);
      console.log(`namehash:    ${c.node}`);
      let resolver = v.resolver as Hex | undefined;
      if (!resolver && (v.rpc ?? process.env.ETH_RPC_URL)) resolver = await lookupResolver(rpcClient(), c.name);
      if (!resolver) console.log("resolver:    (pass --resolver, or --rpc to look it up read-only)");
      else console.log(`resolver:    ${resolver}  (to)`);
      console.log(`calldata:    ${c.data}`);
      console.log("setContenthash(bytes32 node, bytes hash). NOT signed or sent: submit it yourself from the name's controller.");
      return;
    }
    case "verify": {
      if (!v.ref || !v.name) fail("--ref and --name are required");
      const ref = normalizeReference(v.ref);
      const onchain = await readContenthash(rpcClient(), v.name, v.resolver as Hex | undefined);
      if (onchain === "0x") fail(`${v.name} has no contenthash set`);
      let got: string;
      try {
        got = contenthashToSwarmReference(onchain);
      } catch (e) {
        fail(`${v.name} contenthash ${onchain}: ${(e as Error).message}`);
      }
      if (got !== ref) fail(`MISMATCH: ENS has ${got}, expected ${ref}`);
      console.log(`OK: ${v.name} -> bzz://${ref}`);
      if (v.gateway) {
        const url = `${v.gateway.replace(/\/$/, "")}/bzz/${ref}/`;
        const res = await fetch(url);
        if (!res.ok) fail(`gateway ${url} returned ${res.status}`);
        console.log(`gateway OK: ${url} (${res.status})`);
      }
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n${HELP}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
