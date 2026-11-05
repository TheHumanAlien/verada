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
} from "../src/catalog.js";

describe("taxonomy", () => {
  it("has unique, contiguous bits and slugs", () => {
    expect(CATEGORIES.map((c) => c.bit)).toEqual(CATEGORIES.map((_, i) => i));
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
