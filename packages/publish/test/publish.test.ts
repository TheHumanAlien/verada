import { describe, expect, it } from "vitest";
import { encode, decode } from "@ensdomains/content-hash";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contenthashToSwarmReference,
  ensNamehash,
  normalizeReference,
  setContenthashCalldata,
  swarmReferenceToContenthash,
  validateExport,
  estimateStamp,
  validatePack,
} from "../src/index.js";

// Fixed vector from ENSIP-7 (Swarm example).
const REF = "d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";
const HASH = "0xe40101fa011b20" + REF;

describe("contenthash", () => {
  it("matches the ENSIP-7 vector", () => {
    expect(swarmReferenceToContenthash(REF)).toBe(HASH);
    expect(swarmReferenceToContenthash(`bzz://${REF.toUpperCase()}`)).toBe(HASH);
  });
  it("agrees with @ensdomains/content-hash", () => {
    const lib = encode("swarm", REF);
    expect(("0x" + lib.replace(/^0x/, "")).toLowerCase()).toBe(HASH);
    expect(decode(HASH.slice(2))).toBe(REF);
  });
  it("round-trips and rejects non-swarm bytes", () => {
    expect(contenthashToSwarmReference(HASH)).toBe(REF);
    expect(() => contenthashToSwarmReference("0xe3010170122000")).toThrow();
  });
  it("rejects bad refs", () => {
    expect(() => normalizeReference("abcd")).toThrow();
    expect(() => normalizeReference("a".repeat(128))).toThrow(/encrypted/);
  });
  it("computes namehash and calldata", () => {
    expect(ensNamehash("eth")).toBe("0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
    const c = setContenthashCalldata("eth", REF);
    // selector setContenthash(bytes32,bytes) = 0x304e6ade
    expect(c.data.startsWith("0x304e6ade93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae")).toBe(true);
    expect(c.data).toContain(HASH.slice(2));
  });
});

function mk(files: Record<string, string | Buffer>) {
  const d = mkdtempSync(join(tmpdir(), "vp-"));
  for (const [p, c] of Object.entries(files)) {
    const full = join(d, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, c);
  }
  return d;
}

describe("validateExport", () => {
  it("accepts a clean export", () => {
    const d = mk({ "index.html": '<script src="./a.js"></script>', "404.html": "x", "a.js": "1", "tokens/index.html": "y" });
    expect(validateExport(d).errors).toEqual([]);
  });
  it("flags binaries, root-absolute paths and missing index", () => {
    const d = mk({ "index.html": '<link href="/_next/a.css">', "x.png": "a", "k/page.html": "z", "b.dat": Buffer.from([1, 0, 2]) });
    const e = validateExport(d).errors.join("\n");
    expect(e).toMatch(/binary asset.*x\.png/);
    expect(e).toMatch(/root-absolute/);
    expect(e).toMatch(/no index\.html/);
    expect(e).toMatch(/NUL/);
  });
  it("allows budgeted assets under assets/ only", () => {
    const base = { "index.html": "x", "404.html": "x" };
    const ok = mk({ ...base, "assets/scenes/a.avif": Buffer.alloc(300 * 1024, 1), "assets/logo/l.svg": "<svg/>", "assets/c/i.png": Buffer.alloc(50 * 1024, 1), "assets/f/x.woff2": Buffer.alloc(10, 0) });
    expect(validateExport(ok).errors).toEqual([]);
    const bad = mk({
      ...base,
      "assets/big.webp": Buffer.alloc(401 * 1024, 1),
      "assets/orig.png": Buffer.alloc(101 * 1024, 1),
      "assets/photo.jpg": Buffer.alloc(10, 1),
      "logo.svg": "<svg/>",
    });
    expect(validateExport(bad).errors.sort()).toEqual([
      "asset over 400 KB: assets/big.webp",
      "asset type not allowed: assets/photo.jpg",
      "binary asset not allowed: logo.svg",
      "png over 100 KB: assets/orig.png",
    ]);
    const files: Record<string, Buffer | string> = { ...base };
    for (let i = 0; i < 14; i++) files[`assets/s${i}.avif`] = Buffer.alloc(390 * 1024, 1);
    expect(validateExport(mk(files)).errors).toEqual(["assets/ totals 5460 KB, over the 5120 KB budget"]);
  });
});

describe("estimateStamp", () => {
  it("is offline and gives a depth of at least 17", () => {
    const est = estimateStamp([{ path: "index.html", bytes: 5_000_000 }], { ttlDays: 30, pricePerBlock: 24000, blockTime: 5 });
    expect(est.depth).toBeGreaterThanOrEqual(17);
    expect(est.amountPlur > 0n).toBe(true);
  });
});

describe("ENSv2 and feeds", () => {
  it("dns-encodes names for the universal resolver", async () => {
    const { dnsEncode, ENS_V2 } = await import("../src/contenthash.js");
    expect(dnsEncode("varada.eth")).toBe("0x067661726164610365746800");
    expect(ENS_V2.universalResolver.toLowerCase()).toBe("0xeeeeeeee14d718c2b47d9923deab1335e144eeee");
  });
  it("builds setDefaultContenthash calldata for the profile registry", async () => {
    const { setDefaultContenthashCalldata } = await import("../src/contenthash.js");
    const { toFunctionSelector } = await import("viem");
    const registry = "0x1111111111111111111111111111111111111111";
    const c = setDefaultContenthashCalldata(registry, REF);
    expect(c.to).toBe(registry);
    expect(c.contenthash).toBe(HASH);
    expect(c.data.startsWith(toFunctionSelector("setDefaultContenthash(bytes)"))).toBe(true);
    expect(c.data).toContain(HASH.slice(2));
  });
  it("derives the feed owner from the signing key without network", async () => {
    const { feedIdentity, SITE_FEED_TOPIC } = await import("../src/feed.js");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { keccak256, stringToBytes } = await import("viem");
    const key = "0x" + "11".repeat(32);
    const id = feedIdentity(key);
    expect(id.owner.toLowerCase()).toBe(privateKeyToAccount(key as `0x${string}`).address.toLowerCase());
    expect(id.topic).toBe(SITE_FEED_TOPIC);
    expect(id.topicHex).toBe(keccak256(stringToBytes(SITE_FEED_TOPIC)));
    expect(() => feedIdentity("0x1234")).toThrow(/32 bytes/);
  });
});

describe("validatePack", () => {
  it("accepts images and the index within the per-file budget, with no total cap", () => {
    const files: Record<string, Buffer | string> = { "index.json": "{}", "SPYon.svg": "<svg/>" };
    for (let i = 0; i < 20; i++) files[`S${i}-128.webp`] = Buffer.alloc(390 * 1024, 1);
    expect(validatePack(mk(files)).errors).toEqual([]);
  });
  it("rejects a missing index, non-images and oversized files", () => {
    expect(validatePack(mk({ "a-64.webp": "x" })).errors).toEqual(["no index.json at the pack root"]);
    const bad = mk({ "index.json": "{}", "a.js": "1", "f.woff2": "x", "big-128.webp": Buffer.alloc(401 * 1024, 1), "o.png": Buffer.alloc(101 * 1024, 1) });
    expect(validatePack(bad).errors.sort()).toEqual([
      "asset over 400 KB: big-128.webp",
      "not an image in an asset format: a.js",
      "not an image in an asset format: f.woff2",
      "png over 100 KB: o.png",
    ]);
  });
});
