import { describe, expect, it } from "vitest";
import { categoryMaskOf, categorySlugs, regionMaskOf, regionSlugs } from "@verada/sdk";
import { classify, isCoarseNtee, nteeCategoryMask } from "../src/classify.js";

const base = { id: "00000000-0000-0000-0000-000000000001", ein: null, description: null };

describe("NTEE rules", () => {
  it("maps specific codes by prefix, including overlapping categories", () => {
    expect(categorySlugs(nteeCategoryMask("M20"))).toEqual(["disaster-relief"]);
    expect(categorySlugs(nteeCategoryMask("H30"))).toEqual(["cancer-research", "medical-research"]);
    expect(categorySlugs(nteeCategoryMask("D31"))).toEqual(["endangered-species", "animal-welfare"]);
    expect(categorySlugs(nteeCategoryMask("K31"))).toEqual(["hunger"]);
    expect(nteeCategoryMask("Z99")).toBe(0n);
    expect(nteeCategoryMask(null)).toBe(0n);
  });
  it("treats unclassified and major-only codes as coarse", () => {
    for (const c of [null, "", "Z00", "E", "A00", "Q99"]) expect(isCoarseNtee(c)).toBe(true);
    for (const c of ["M20", "Q33", "B21"]) expect(isCoarseNtee(c)).toBe(false);
  });
});

describe("classify", () => {
  it("uses keywords for an unclassified international org and its HQ country", () => {
    const c = classify({ ...base, name: "Acres of Mercy, Kenya", nteeCode: "Z00", country: "KEN", description: "We run an orphanage and feeding program for children." });
    expect(categorySlugs(c.categoryMask)).toEqual(expect.arrayContaining(["children-youth", "hunger"]));
    expect(regionSlugs(c.regionMask)).toEqual(["africa"]);
    expect(c.sources.categories).toContain("keyword");
  });
  it("does not add keyword categories to a specifically coded org", () => {
    const c = classify({ ...base, name: "Kids Cancer Fund", nteeCode: "G30", country: "USA", description: "children" });
    expect(categorySlugs(c.categoryMask)).toEqual(["disease", "cancer-research"]);
  });
  it("adds Global and named operating areas for international (Q) orgs", () => {
    const c = classify({ ...base, name: "Relief for East Africa", nteeCode: "Q33", country: "USA", description: "Famine relief in Somalia and Haiti" });
    expect(regionSlugs(c.regionMask)).toEqual(["africa", "north-america", "latin-america", "global"]);
  });
  it("ignores place names for domestic orgs", () => {
    const c = classify({ ...base, name: "Kenya Community Center of Ohio", nteeCode: "P20", country: "USA" });
    expect(regionSlugs(c.regionMask)).toEqual(["north-america"]);
  });
  it("matches whole words only", () => {
    const c = classify({ ...base, name: "Childress Arts Guild", nteeCode: "A00", country: "USA" });
    expect(categorySlugs(c.categoryMask)).toEqual(["other"]);
  });
  it("falls back to other / global", () => {
    const c = classify({ ...base, name: "Zxq", nteeCode: null, country: null });
    expect(categorySlugs(c.categoryMask)).toEqual(["other"]);
    expect(regionSlugs(c.regionMask)).toEqual(["global"]);
  });
  it("applies overrides by EIN, replacing or adding", () => {
    const org = { ...base, ein: "12-3456789", name: "Feed Them", nteeCode: "K31", country: "USA" };
    const replaced = classify(org, { orgs: { "123456789": { regions: ["africa"] } } });
    expect(replaced.regionMask).toBe(regionMaskOf(["africa"]));
    const added = classify(org, { orgs: { "123456789": { regions: ["asia"], categories: ["children-youth"], mode: "add" } } });
    expect(regionSlugs(added.regionMask)).toEqual(["asia", "north-america"]);
    expect(added.categoryMask).toBe(categoryMaskOf(["hunger", "children-youth"]));
  });
});

describe("education keywords", () => {
  it("catches specific education words for coarse codes but not charter boilerplate", () => {
    const edu = (name: string, description: string | null = null) =>
      categorySlugs(classify({ ...base, name, description, nteeCode: "Q30", country: "USA" }).categoryMask).includes("education");
    expect(edu("American Foundation for the University of Nairobi")).toBe(true);
    expect(edu("Adult Vocational Programs")).toBe(true);
    expect(edu("Helping Hands", "We pay tuition and train teachers in rural Kenya")).toBe(true);
    expect(edu("Border Watch", "Organized exclusively for charitable and educational purposes")).toBe(false);
  });
});

describe("justice", () => {
  it("places innocence work in justice whatever the NTEE code", () => {
    const cats = (o: Partial<Parameters<typeof classify>[0]>) =>
      categorySlugs(classify({ ...base, name: "x", nteeCode: "R20", country: "USA", ...o }).categoryMask);
    // A specific civil-rights code: human rights from NTEE, justice from the phrase.
    expect(cats({ name: "Midwest Innocence Project" })).toEqual(["human-rights", "justice"]);
    expect(cats({ name: "Second Chance", description: "Freeing the wrongfully convicted" })).toContain("justice");
    // Legal services and prison alternatives by NTEE.
    expect(cats({ nteeCode: "I80" })).toEqual(["justice"]);
    expect(cats({ nteeCode: "I44" })).toEqual(["justice"]);
    // Broad words only count for coarse codes.
    expect(cats({ nteeCode: "B20", description: "Tutoring for children of prisoners" })).not.toContain("justice");
    expect(cats({ nteeCode: "Z00", description: "Legal aid for prisoners in Uganda" })).toContain("justice");
  });
});
