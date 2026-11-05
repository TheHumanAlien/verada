import {
  CATEGORIES,
  COUNTRY_REGIONS,
  GLOBAL_REGION_BIT,
  OPERATING_AREA_TERMS,
  OTHER_CATEGORY_BIT,
  categoryMaskOf,
  regionMaskOf,
} from "@verada/sdk";

/** The fields of a harvested org that classification reads. */
export interface ClassifiableOrg {
  id: string;
  ein?: string | null;
  name: string;
  description?: string | null;
  nteeCode?: string | null;
  country?: string | null;
}

export type TagSource = "ntee" | "keyword" | "country" | "text" | "override" | "fallback";

export interface Classification {
  categoryMask: bigint;
  regionMask: number;
  /** Where each tag came from, for review and for the UI ("matched by keyword"). */
  sources: { categories: TagSource[]; regions: TagSource[] };
}

export interface RegionOverride {
  /** Replaces the computed regions when `mode` is "replace" (default), else adds to them. */
  regions?: string[];
  categories?: string[];
  mode?: "replace" | "add";
}

/** `region-overrides.json`: keyed by EIN digits (no hyphen) or Endaoment org id. */
export interface Overrides {
  orgs: Record<string, RegionOverride>;
}

const wordRe = (terms: readonly string[]): RegExp | null => {
  if (terms.length === 0) return null;
  const alt = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "iu");
};

const CATEGORY_RULES = CATEGORIES.map((c) => ({ ...c, re: wordRe(c.keywords), always: wordRe(c.alwaysKeywords ?? []) }));
const AREA_TERMS = Object.entries(OPERATING_AREA_TERMS).map(([term, mask]) => ({ re: wordRe([term])!, mask }));

/**
 * A code too coarse to place an org: missing, unclassified (`Z..`), a bare major group (`E`) or a
 * major group with the generic `00`/`99` suffix (`A00`, `Q99`). Such orgs are classified from text.
 */
export function isCoarseNtee(code: string | null | undefined): boolean {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || c.startsWith("Z")) return true;
  return /^[A-Y]$/.test(c) || /^[A-Y](00|99)$/.test(c);
}

export function nteeCategoryMask(code: string | null | undefined): bigint {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || c.startsWith("Z")) return 0n;
  let mask = 0n;
  for (const cat of CATEGORIES) {
    if (cat.ntee.some((p) => c.startsWith(p))) mask |= 1n << BigInt(cat.bit);
  }
  return mask;
}

export function keywordCategoryMask(text: string): bigint {
  let mask = 0n;
  for (const r of CATEGORY_RULES) if (r.re?.test(text)) mask |= 1n << BigInt(r.bit);
  return mask;
}

/** Categories whose high-precision phrases appear in the text (applied whatever the NTEE code). */
export function alwaysCategoryMask(text: string): bigint {
  let mask = 0n;
  for (const r of CATEGORY_RULES) if (r.always?.test(text)) mask |= 1n << BigInt(r.bit);
  return mask;
}

export function operatingAreaMask(text: string): number {
  let mask = 0;
  for (const t of AREA_TERMS) if (t.re.test(text)) mask |= t.mask;
  return mask;
}

const overrideKey = (o: ClassifiableOrg): string[] =>
  [o.ein?.replace(/-/g, "").trim(), o.id.trim()].filter((k): k is string => !!k);

/**
 * Category and region of an org.
 *
 * Categories: NTEE prefixes when the code is specific; name/description keywords when it is
 * coarse (most international orgs are `Z00`) or international (`Q*`, which says where an org
 * works but not on what); the catch-all `other` when nothing matches.
 *
 * Regions: the HQ country. Orgs with an international NTEE code (`Q*`) also get Global plus any
 * region named in their text, because their HQ (usually the USA) says nothing about where they
 * work. Curated overrides apply last.
 */
export function classify(org: ClassifiableOrg, overrides?: Overrides): Classification {
  const text = `${org.name}\n${org.description ?? ""}`;
  const catSources = new Set<TagSource>();
  const regSources = new Set<TagSource>();

  let categoryMask = nteeCategoryMask(org.nteeCode);
  if (categoryMask !== 0n) catSources.add("ntee");
  const ntee = (org.nteeCode ?? "").trim().toUpperCase();
  if (isCoarseNtee(ntee) || ntee.startsWith("Q")) {
    const kw = keywordCategoryMask(text);
    if (kw !== 0n) {
      categoryMask |= kw;
      catSources.add("keyword");
    }
  }
  const always = alwaysCategoryMask(text);
  if ((always & ~categoryMask) !== 0n) {
    categoryMask |= always;
    catSources.add("keyword");
  }

  const country = (org.country ?? "").trim().toUpperCase();
  let regionMask = COUNTRY_REGIONS[country] ?? 0;
  if (regionMask !== 0) regSources.add("country");
  if (ntee.startsWith("Q")) {
    regionMask |= 1 << GLOBAL_REGION_BIT;
    const area = operatingAreaMask(text);
    regionMask |= area;
    if (area !== 0) regSources.add("text");
  }

  for (const key of overrideKey(org)) {
    const ov = overrides?.orgs[key];
    if (!ov) continue;
    const add = ov.mode === "add";
    if (ov.regions) {
      const m = regionMaskOf(ov.regions);
      regionMask = add ? regionMask | m : m;
      regSources.add("override");
    }
    if (ov.categories) {
      const m = categoryMaskOf(ov.categories);
      categoryMask = add ? categoryMask | m : m;
      catSources.add("override");
    }
    break;
  }

  if (categoryMask === 0n) {
    categoryMask = 1n << BigInt(OTHER_CATEGORY_BIT);
    catSources.add("fallback");
  }
  if (regionMask === 0) {
    regionMask = 1 << GLOBAL_REGION_BIT;
    regSources.add("fallback");
  }
  return {
    categoryMask,
    regionMask,
    sources: { categories: [...catSources], regions: [...regSources] },
  };
}
