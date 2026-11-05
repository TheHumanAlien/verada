import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { describe, expect, it } from "vitest";
import { BUCKET_COUNT, bucketId, categoryBySlug, regionBySlug } from "@verada/sdk";
import { buildCatalog, entryProof } from "../src/build.js";
import { readCatalog, writeCatalog } from "../src/io.js";
import { org } from "./fixtures.js";

const HUNGER_NA = bucketId(categoryBySlug("hunger").bit, regionBySlug("north-america").bit);

describe("buildCatalog", () => {
  it("filters ineligible orgs and records why", () => {
    const { catalog, rejected } = buildCatalog([
      org(1),
      org(2, { isCompliant: false }),
      org(3, { mainnetAddress: null }),
      org(4, { ein: null, id: "not-a-uuid" }),
      org(5, { id: "00000000-0000-0000-0000-999999999999", ein: String(100000001) }),
    ]);
    expect(catalog.orgs.map((o) => o.ein)).toEqual(["100000001"]);
    expect(rejected.map((r) => r.reason).sort()).toEqual(["duplicate-org-id", "no-mainnet-address", "no-org-id", "non-compliant"]);
  });

  it("is deterministic regardless of input order and buckets sort by orgId", () => {
    const input = [org(3), org(1), org(2)];
    const a = buildCatalog(input).catalog;
    const b = buildCatalog([...input].reverse()).catalog;
    expect(a.meta.root).toBe(b.meta.root);
    expect(a.meta.bucketSizes).toHaveLength(BUCKET_COUNT);
    expect(a.meta.bucketSizes[HUNGER_NA]).toBe(3);
    const ids = [...a.tree.entries()].filter(([, l]) => l[0] === HUNGER_NA).map(([, l]) => l[2]);
    expect(ids).toEqual([...ids].sort());
  });

  it("puts an org in every category x region bucket it matches, with verifiable proofs", () => {
    const { catalog } = buildCatalog([org(1, { nteeCode: "Q33", description: "famine relief in Kenya" })]);
    const o = catalog.orgs[0]!;
    expect(o.categories).toEqual(["disaster-relief", "hunger"]);
    expect(o.regions).toEqual(["africa", "north-america", "global"]);
    expect(o.entries).toHaveLength(6);
    for (const e of o.entries) {
      const proof = entryProof(catalog.tree, { ...e, orgId: o.orgId });
      expect(StandardMerkleTree.verify(catalog.meta.root, ["uint16", "uint32", "bytes32"], [e.bucket, e.index, o.orgId], proof)).toBe(true);
    }
  });

  it("round-trips through the published files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-"));
    const { catalog } = buildCatalog([org(1), org(2, { country: "KEN", nteeCode: "Z00", description: "orphanage" })]);
    await writeCatalog(dir, catalog);
    const back = await readCatalog(dir);
    expect(back.meta.root).toBe(catalog.meta.root);
    expect(back.orgs).toEqual(catalog.orgs);
  });
});
