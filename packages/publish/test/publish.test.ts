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
});

describe("estimateStamp", () => {
  it("is offline and gives a depth of at least 17", () => {
    const est = estimateStamp([{ path: "index.html", bytes: 5_000_000 }], { ttlDays: 30, pricePerBlock: 24000, blockTime: 5 });
    expect(est.depth).toBeGreaterThanOrEqual(17);
    expect(est.amountPlur > 0n).toBe(true);
  });
});
