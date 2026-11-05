import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES_MASK,
  ALL_REGIONS_MASK,
  BUCKET_COUNT,
  CATEGORIES,
  COUNTRY_REGIONS,
  REGIONS,
  bucketId,
  categoryMaskOf,
  drawIndex,
  focusBuckets,
  locate,
  poolSize,
  regionMaskOf,
  planRotation,
  causeIdOfOrg,
} from "../src/catalog.js";

describe("taxonomy", () => {
  it("has unique, contiguous bits and slugs", () => {
    // Bits are contiguous; display order may differ (the catch-all stays last).
    expect(CATEGORIES.map((c) => c.bit).sort((a, b) => a - b)).toEqual(CATEGORIES.map((_, i) => i));
    expect(CATEGORIES[CATEGORIES.length - 1]!.slug).toBe("other");
    expect(REGIONS.map((r) => r.bit)).toEqual(REGIONS.map((_, i) => i));
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(CATEGORIES.length);
    expect(CATEGORIES.length).toBeLessThanOrEqual(64);
    expect(REGIONS.length).toBeLessThanOrEqual(16);
  });
  it("maps country codes to regions", () => {
    expect(COUNTRY_REGIONS.KEN).toBe(regionMaskOf(["africa"]));
    expect(COUNTRY_REGIONS.EGY).toBe(regionMaskOf(["africa", "middle-east"]));
    expect(COUNTRY_REGIONS.USA).toBe(regionMaskOf(["north-america"]));
    expect(COUNTRY_REGIONS.BRA).toBe(regionMaskOf(["latin-america"]));
    for (const k of Object.keys(COUNTRY_REGIONS)) expect(k).toMatch(/^[A-Z]{3}$/);
  });
});

describe("pool math", () => {
  const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
  const hungerAf = bucketId(2, 0);
  const hungerNa = bucketId(2, 4);
  const kidsAf = bucketId(3, 0);
  sizes[hungerAf] = 5;
  sizes[hungerNa] = 7;
  sizes[kidsAf] = 3;

  it("sums the buckets of a focus", () => {
    expect(poolSize(sizes, categoryMaskOf(["hunger"]), regionMaskOf(["africa"]))).toBe(5);
    expect(poolSize(sizes, categoryMaskOf(["hunger", "children-youth"]), regionMaskOf(["africa"]))).toBe(8);
    expect(poolSize(sizes, ALL_CATEGORIES_MASK, ALL_REGIONS_MASK)).toBe(15);
  });
  it("locates pool indices in ascending bucket order", () => {
    const cm = ALL_CATEGORIES_MASK;
    const rm = ALL_REGIONS_MASK;
    expect(focusBuckets(sizes, cm, rm).map((b) => b.bucket)).toEqual([hungerAf, hungerNa, kidsAf]);
    expect(locate(sizes, cm, rm, 0)).toEqual({ bucket: hungerAf, index: 0 });
    expect(locate(sizes, cm, rm, 5)).toEqual({ bucket: hungerNa, index: 0 });
    expect(locate(sizes, cm, rm, 12)).toEqual({ bucket: kidsAf, index: 0 });
    expect(() => locate(sizes, cm, rm, 15)).toThrow(RangeError);
  });
  it("draws deterministically within the pool", () => {
    const t = "0x00000000000000000000000000000000000000aa";
    const a = drawIndex(t, 3n, 1, 0, 1000);
    expect(drawIndex(t, 3n, 1, 0, 1000)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1000);
    const spread = new Set(Array.from({ length: 50 }, (_, k) => drawIndex(t, 3n, 1, k, 1000)));
    expect(spread.size).toBeGreaterThan(40);
    expect(() => drawIndex(t, 3n, 1, 0, 0)).toThrow();
  });
});

describe("planRotation", () => {
  const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
  sizes[bucketId(2, 0)] = 30;
  const org = (b: number, i: number) => (`0x${b.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}`) as `0x${string}`;
  const base = {
    token: "0x00000000000000000000000000000000000000aa" as const,
    epoch: 4n,
    version: 1,
    bucketSizes: sizes,
    categoryMask: categoryMaskOf(["hunger"]),
    regionMask: regionMaskOf(["africa"]),
    pinned: [],
    ballotSize: 10,
  };
  const deps = { entryAt: async (b: number, i: number) => org(b, i), isBlocked: async () => false };

  it("fills a ballot of distinct causes from hash draws", async () => {
    const r = await planRotation(base, deps);
    expect(r.poolSize).toBe(30);
    expect(r.options).toHaveLength(10);
    expect(new Set(r.options).size).toBe(10);
    expect(r.draws.length).toBeGreaterThanOrEqual(10);
    expect(r.draws[0]!.index).toBe(drawIndex(base.token, 4n, 1, 0, 30));
  });

  it("walks the pool in order when it fits, and keeps pins first", async () => {
    const pin = causeIdOfOrg(org(bucketId(2, 0), 3));
    const r = await planRotation({ ...base, ballotSize: 32, pinned: [pin] }, deps);
    expect(r.draws.map((d) => d.index)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(r.options[0]).toBe(pin.toLowerCase());
    expect(r.options).toHaveLength(30); // 1 pin + 29 new (the pinned org repeats)
  });

  it("supplies skipped draws for blocked causes and needs none with no catalogue", async () => {
    const blocked = causeIdOfOrg(org(bucketId(2, 0), drawIndex(base.token, 4n, 1, 0, 30))).toLowerCase();
    const r = await planRotation(base, { ...deps, isBlocked: async (c) => c === blocked });
    expect(r.options).not.toContain(blocked);
    expect(r.draws[0]!.index).toBe(drawIndex(base.token, 4n, 1, 0, 30));
    expect((await planRotation({ ...base, version: 0 }, deps)).draws).toEqual([]);
  });
});
