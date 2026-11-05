import { encodeAbiParameters, hexToBigInt, keccak256, type Address, type Hex } from "viem";

/**
 * Cause catalogue taxonomy and bucket math, shared by the catalogue builder, the indexer, the
 * keeper and the web app. The bucket layout and the rotation draw must match `CauseCatalog` and
 * `EpochGovernor` exactly; `test/catalog.test.ts` pins them.
 */

/** Bumped whenever a category or region bit changes meaning. Stamped on every catalogue. */
export const TAXONOMY_VERSION = 2;

/** Region slots per category in the bucket layout (`bucket = categoryBit * REGION_SLOTS + regionBit`). */
export const REGION_SLOTS = 16;

export interface CategoryDef {
  bit: number;
  slug: string;
  label: string;
  /**
   * NTEE code prefixes that place an org in this category. A prefix matches when the org's code
   * starts with it (`"D3"` matches D30..D39, `"G"` matches every G code).
   */
  ntee: readonly string[];
  /**
   * Case-insensitive whole-word patterns matched against name and description, used only when
   * the NTEE code is missing, unclassified (`Z`), coarse (a major-group-only code such as
   * `A00`, `E`) or international (`Q*`). Most non-US organizations fall in one of these.
   */
  keywords: readonly string[];
  /**
   * High-precision phrases matched against every org whatever its NTEE code, for causes that
   * organizations file under general codes (an innocence project is often coded as legal
   * services or civil rights).
   */
  alwaysKeywords?: readonly string[];
  /**
   * Short ENS word of the category's curator agent (`<ensLabel>.agent.varada.eth`). Permanent once
   * an agent is registered. The catch-all `other` has no agent.
   */
  ensLabel?: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  {
    bit: 0,
    slug: "disaster-relief",
    ensLabel: "disaster",
    label: "Disaster relief",
    ntee: ["M20", "M23", "P60", "Q33"],
    keywords: ["disaster", "earthquake", "flood", "floods", "hurricane", "cyclone", "tsunami", "wildfire", "emergency relief", "humanitarian relief"],
  },
  {
    bit: 1,
    slug: "homelessness",
    ensLabel: "homeless",
    label: "Homelessness",
    ntee: ["L41", "P85", "L40"],
    keywords: ["homeless", "homelessness", "unhoused", "street children", "street kids"],
  },
  {
    bit: 2,
    slug: "hunger",
    ensLabel: "hunger",
    label: "Hunger & famine",
    ntee: ["K3", "K40"],
    keywords: ["hunger", "famine", "food bank", "food security", "malnutrition", "malnourished", "feeding program", "feeding programme", "nutrition"],
  },
  {
    bit: 3,
    slug: "children-youth",
    ensLabel: "children",
    label: "Children & youth",
    ntee: ["O", "P30", "P31", "P32", "P33"],
    keywords: ["children", "child", "orphan", "orphans", "orphanage", "orphaned", "youth", "kids", "girl child"],
  },
  {
    bit: 4,
    slug: "disease",
    ensLabel: "disease",
    label: "Disease",
    ntee: ["G"],
    keywords: ["disease", "diseases", "malaria", "hiv", "aids", "tuberculosis", "cholera", "epilepsy", "sickle cell", "diabetes", "leprosy"],
  },
  {
    bit: 5,
    slug: "cancer-research",
    ensLabel: "cancer",
    label: "Cancer",
    ntee: ["G30", "H30"],
    keywords: ["cancer", "oncology", "leukemia", "leukaemia", "tumor", "tumour", "lymphoma"],
  },
  {
    bit: 6,
    slug: "endangered-species",
    ensLabel: "wildlife",
    label: "Wildlife & endangered species",
    ntee: ["D30", "D31", "D32", "D33", "D34"],
    keywords: ["endangered", "wildlife", "species", "elephant", "elephants", "rhino", "rhinos", "gorilla", "gorillas", "poaching", "biodiversity"],
  },
  {
    bit: 7,
    slug: "animal-welfare",
    ensLabel: "animals",
    label: "Animal welfare",
    ntee: ["D"],
    keywords: ["animal", "animals", "animal rescue", "animal welfare", "veterinary"],
  },
  {
    bit: 8,
    slug: "environment-climate",
    ensLabel: "environment",
    label: "Environment & climate",
    ntee: ["C"],
    keywords: ["climate", "environment", "environmental", "reforestation", "deforestation", "conservation", "ocean", "oceans", "pollution", "renewable"],
  },
  {
    bit: 9,
    slug: "clean-water",
    ensLabel: "water",
    label: "Clean water & sanitation",
    ntee: ["C32"],
    keywords: ["clean water", "safe water", "drinking water", "water wells", "boreholes", "borehole", "sanitation"],
  },
  {
    bit: 10,
    slug: "health-care",
    ensLabel: "health",
    label: "Health care",
    ntee: ["E"],
    keywords: ["health", "healthcare", "health care", "clinic", "clinics", "hospital", "maternal", "medical"],
  },
  {
    bit: 11,
    slug: "mental-health",
    ensLabel: "mental-health",
    label: "Mental health",
    ntee: ["F"],
    keywords: ["mental health", "suicide", "addiction", "depression", "trauma", "psychosocial"],
  },
  {
    bit: 12,
    slug: "medical-research",
    ensLabel: "research",
    label: "Medical research",
    ntee: ["H"],
    keywords: ["medical research", "clinical research", "biomedical"],
  },
  {
    bit: 13,
    slug: "education",
    ensLabel: "education",
    label: "Education",
    ntee: ["B"],
    keywords: [
      // Not "educational"/"educate": charters say "charitable and educational purposes" for anything.
      "education", "school", "schools", "schooling", "literacy",
      "scholarship", "scholarships", "learning", "students", "pupils", "teacher", "teachers", "tutoring",
      "tuition", "classroom", "classrooms", "vocational", "university", "universities", "college", "colleges",
    ],
  },
  {
    bit: 14,
    slug: "refugees",
    ensLabel: "refugees",
    label: "Refugees & displaced people",
    ntee: ["Q71", "P84"],
    keywords: ["refugee", "refugees", "displaced", "asylum", "idps"],
  },
  {
    bit: 15,
    slug: "human-rights",
    ensLabel: "human-rights",
    label: "Human rights",
    ntee: ["R"],
    keywords: ["human rights", "civil rights", "trafficking", "justice", "advocacy"],
  },
  {
    bit: 16,
    slug: "women-girls",
    ensLabel: "women",
    label: "Women & girls",
    ntee: ["R24", "P43"],
    keywords: ["girls", "women's", "womens", "gender-based", "gender equality", "widows", "maternal"],
  },
  {
    bit: 17,
    slug: "poverty",
    ensLabel: "poverty",
    label: "Poverty & livelihoods",
    ntee: ["P20", "S20", "S30", "Q30"],
    keywords: ["poverty", "poor", "livelihood", "livelihoods", "microfinance", "vulnerable", "empowerment", "rural development"],
  },
  {
    bit: 18,
    slug: "veterans",
    ensLabel: "veterans",
    label: "Veterans",
    ntee: ["W30"],
    keywords: ["veteran", "veterans"],
  },
  {
    bit: 20,
    slug: "justice",
    ensLabel: "justice",
    label: "Justice & the wrongly accused",
    // Offender rehabilitation, inmate support, prison alternatives, administration of justice,
    // legal services, public interest law.
    ntee: ["I40", "I43", "I44", "I50", "I80", "I83"],
    keywords: [
      "legal aid", "public defender", "public defenders", "criminal justice", "justice reform", "incarcerated",
      "prisoners", "prisoner", "prison", "prisons", "reentry", "re-entry", "bail", "death row", "wrongful", "innocent",
    ],
    alwaysKeywords: [
      "wrongful conviction", "wrongful convictions", "wrongfully convicted", "wrongly convicted", "wrongly accused",
      "falsely accused", "falsely convicted", "exoneration", "exonerations", "exonerate", "exonerated", "exoneree",
      "exonerees", "innocence project", "innocence network", "actual innocence",
    ],
  },
  {
    bit: 19,
    slug: "other",
    label: "Other",
    ntee: [],
    keywords: [],
  },
] as const;

/** Bit of the catch-all category given to orgs no rule places anywhere else. */
export const OTHER_CATEGORY_BIT = 19;

export interface RegionDef {
  bit: number;
  slug: string;
  label: string;
}

export const REGIONS: readonly RegionDef[] = [
  { bit: 0, slug: "africa", label: "Africa" },
  { bit: 1, slug: "asia", label: "Asia" },
  { bit: 2, slug: "europe", label: "Europe" },
  { bit: 3, slug: "middle-east", label: "Middle East" },
  { bit: 4, slug: "north-america", label: "North America" },
  { bit: 5, slug: "latin-america", label: "Latin America & Caribbean" },
  { bit: 6, slug: "oceania", label: "Oceania" },
  { bit: 7, slug: "global", label: "Global" },
] as const;

export const GLOBAL_REGION_BIT = 7;

/** Every defined category bit set. */
export const ALL_CATEGORIES_MASK: bigint = CATEGORIES.reduce((m, c) => m | (1n << BigInt(c.bit)), 0n);
/** Every defined region bit set. */
export const ALL_REGIONS_MASK: number = REGIONS.reduce((m, r) => m | (1 << r.bit), 0);
/** Number of buckets in a catalogue (`bucketSizes.length`). */
export const BUCKET_COUNT = CATEGORIES.length * REGION_SLOTS;

const R = (slug: string): number => {
  const r = REGIONS.find((x) => x.slug === slug);
  if (!r) throw new Error(`unknown region ${slug}`);
  return 1 << r.bit;
};
const AF = R("africa");
const AS = R("asia");
const EU = R("europe");
const ME = R("middle-east");
const NA = R("north-america");
const LA = R("latin-america");
const OC = R("oceania");
const GL = R("global");

function codes(list: string, mask: number): [string, number][] {
  return list.split(/\s+/).filter(Boolean).map((c) => [c, mask]);
}

/** ISO 3166-1 alpha-3 country code to region mask (HQ location). Unknown codes map to Global. */
export const COUNTRY_REGIONS: Readonly<Record<string, number>> = Object.fromEntries([
  ...codes(
    "DZA AGO BEN BWA BFA BDI CPV CMR CAF TCD COM COG COD CIV DJI GNQ ERI SWZ ETH GAB GMB GHA GIN GNB KEN LSO LBR LBY MDG MWI MLI MRT MUS MAR MOZ NAM NER NGA RWA STP SEN SYC SLE SOM ZAF SSD SDN TZA TGO TUN UGA ZMB ZWE ESH REU MYT SHN",
    AF,
  ),
  ...codes("EGY", AF | ME),
  ...codes(
    "AFG ARM AZE BGD BTN BRN KHM CHN GEO HKG IND IDN JPN KAZ PRK KOR KGZ LAO MAC MYS MDV MNG MMR NPL PAK PHL SGP LKA TWN TJK THA TLS TKM UZB VNM IOT CXR CCK",
    AS,
  ),
  ...codes("ARE BHR IRN IRQ ISR JOR KWT LBN OMN PSE QAT SAU SYR TUR YEM", ME),
  ...codes(
    "ALB AND AUT BLR BEL BIH BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN ISL IRL ITA XKX LVA LIE LTU LUX MLT MDA MCO MNE NLD MKD NOR POL PRT ROU SMR SRB SVK SVN ESP SWE CHE UKR GBR VAT FRO GIB GGY IMN JEY ALA SJM",
    EU,
  ),
  ...codes("RUS", EU | AS),
  ...codes("USA CAN BMU GRL SPM UMI", NA),
  ...codes(
    "MEX GTM BLZ SLV HND NIC CRI PAN CUB JAM HTI DOM PRI BHS BRB TTO GRD LCA VCT ATG DMA KNA ABW CUW SXM BES VGB VIR CYM TCA AIA MSR GLP MTQ BLM MAF ARG BOL BRA CHL COL ECU GUY PRY PER SUR URY VEN GUF FLK SGS",
    LA,
  ),
  ...codes("AUS NZL PNG FJI SLB VUT NCL PYF WSM ASM TON TUV KIR NRU FSM MHL PLW GUM MNP COK NIU TKL WLF PCN NFK HMD", OC),
  ...codes("ATA ATF BVT", GL),
]);

/**
 * Place names that signal where an internationally focused org works. Only unambiguous names:
 * words that are also US states, people's names or common nouns (Georgia, Jordan, Chad, Turkey,
 * Guinea, Niger, Jersey, Pacific) are left out or only appear in a qualified form.
 */
export const OPERATING_AREA_TERMS: Readonly<Record<string, number>> = {
  africa: AF, african: AF, "sub-saharan": AF, "east africa": AF, "west africa": AF, sahel: AF,
  kenya: AF, uganda: AF, tanzania: AF, ethiopia: AF, somalia: AF, sudan: AF, "south sudan": AF,
  nigeria: AF, ghana: AF, rwanda: AF, burundi: AF, malawi: AF, zambia: AF, zimbabwe: AF,
  mozambique: AF, madagascar: AF, congo: AF, drc: AF, cameroon: AF, senegal: AF, "burkina faso": AF,
  "sierra leone": AF, liberia: AF, "south africa": AF, botswana: AF, namibia: AF, angola: AF,
  eritrea: AF, lesotho: AF, eswatini: AF, swaziland: AF, togo: AF, benin: AF, "ivory coast": AF,
  "cote d'ivoire": AF, morocco: AF, tunisia: AF, algeria: AF, libya: AF, egypt: AF | ME,
  asia: AS, asian: AS, "southeast asia": AS, "south asia": AS, india: AS, nepal: AS, bangladesh: AS,
  pakistan: AS, afghanistan: AS, cambodia: AS, myanmar: AS, burma: AS, vietnam: AS, philippines: AS,
  indonesia: AS, "sri lanka": AS, laos: AS, thailand: AS, mongolia: AS, "north korea": AS,
  "middle east": ME, syria: ME, yemen: ME, lebanon: ME, iraq: ME, gaza: ME, palestine: ME,
  palestinian: ME, "west bank": ME, iran: ME,
  europe: EU, european: EU, ukraine: EU, moldova: EU, romania: EU, albania: EU, bosnia: EU,
  kosovo: EU, serbia: EU, belarus: EU,
  "latin america": LA, caribbean: LA, "central america": LA, "south america": LA, haiti: LA,
  guatemala: LA, honduras: LA, nicaragua: LA, "el salvador": LA, bolivia: LA, peru: LA, ecuador: LA,
  colombia: LA, venezuela: LA, brazil: LA, mexico: LA, "dominican republic": LA, cuba: LA,
  jamaica: LA, paraguay: LA, argentina: LA, chile: LA,
  oceania: OC, "pacific islands": OC, "papua new guinea": OC, fiji: OC, samoa: OC,
  tonga: OC, vanuatu: OC, "solomon islands": OC,
};

// ---------------------------------------------------------------- masks and buckets

export function categoryBySlug(slug: string): CategoryDef {
  const c = CATEGORIES.find((x) => x.slug === slug);
  if (!c) throw new Error(`unknown category ${slug}`);
  return c;
}

export function regionBySlug(slug: string): RegionDef {
  const r = REGIONS.find((x) => x.slug === slug);
  if (!r) throw new Error(`unknown region ${slug}`);
  return r;
}

export function categoryMaskOf(slugs: readonly string[]): bigint {
  return slugs.reduce((m, s) => m | (1n << BigInt(categoryBySlug(s).bit)), 0n);
}

export function regionMaskOf(slugs: readonly string[]): number {
  return slugs.reduce((m, s) => m | (1 << regionBySlug(s).bit), 0);
}

export function categorySlugs(mask: bigint): string[] {
  return CATEGORIES.filter((c) => (mask >> BigInt(c.bit)) & 1n).map((c) => c.slug);
}

export function regionSlugs(mask: number): string[] {
  return REGIONS.filter((r) => (mask >> r.bit) & 1).map((r) => r.slug);
}

export function bucketId(categoryBit: number, regionBit: number): number {
  if (regionBit < 0 || regionBit >= REGION_SLOTS) throw new RangeError("region bit out of range");
  return categoryBit * REGION_SLOTS + regionBit;
}

export function bucketParts(bucket: number): { categoryBit: number; regionBit: number } {
  return { categoryBit: Math.floor(bucket / REGION_SLOTS), regionBit: bucket % REGION_SLOTS };
}

/** Whether `bucket` lies inside a focus. Mirrors `CauseCatalog.inFocus`. */
export function inFocus(bucket: number, categoryMask: bigint, regionMask: number): boolean {
  const { categoryBit, regionBit } = bucketParts(bucket);
  return ((categoryMask >> BigInt(categoryBit)) & 1n) === 1n && ((regionMask >> regionBit) & 1) === 1;
}

/** Buckets of a focus with their sizes, in ascending bucket order (the pool's index order). */
export function focusBuckets(
  bucketSizes: readonly number[],
  categoryMask: bigint,
  regionMask: number,
): { bucket: number; size: number }[] {
  const out: { bucket: number; size: number }[] = [];
  for (let b = 0; b < bucketSizes.length; b++) {
    const size = bucketSizes[b] ?? 0;
    if (size > 0 && inFocus(b, categoryMask, regionMask)) out.push({ bucket: b, size });
  }
  return out;
}

/** Number of entries in a focus pool. Mirrors `CauseCatalog.poolSize`. */
export function poolSize(bucketSizes: readonly number[], categoryMask: bigint, regionMask: number): number {
  return focusBuckets(bucketSizes, categoryMask, regionMask).reduce((n, b) => n + b.size, 0);
}

/** Maps a pool index to `(bucket, index)`. Mirrors `CauseCatalog.locate`. */
export function locate(
  bucketSizes: readonly number[],
  categoryMask: bigint,
  regionMask: number,
  poolIndex: number,
): { bucket: number; index: number } {
  let rest = poolIndex;
  for (const { bucket, size } of focusBuckets(bucketSizes, categoryMask, regionMask)) {
    if (rest < size) return { bucket, index: rest };
    rest -= size;
  }
  throw new RangeError(`pool index ${poolIndex} out of range`);
}

/**
 * Pool index of the `k`-th rotation draw of `token`'s ballot for `epoch` under catalogue
 * `version`. Mirrors `EpochGovernor._drawIndex`:
 * `uint256(keccak256(abi.encode(token, epoch, version, k))) % poolSize`.
 */
export function drawIndex(token: Address, epoch: bigint, version: number, k: number, size: number): number {
  if (size <= 0) throw new RangeError("empty pool");
  const h = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint32" }, { type: "uint256" }],
      [token, epoch, version, BigInt(k)],
    ),
  );
  return Number(hexToBigInt(h) % BigInt(size));
}

/** Merkle leaf value types of a catalogue entry (OpenZeppelin standard tree encoding). */
export const CATALOG_LEAF_TYPES = ["uint16", "uint32", "bytes32"] as const;

export interface CatalogEntry {
  bucket: number;
  index: number;
  orgId: Hex;
}

/** `EpochGovernor.DRAW_FACTOR`: rotation gives up after this many draws per free slot. */
export const DRAW_FACTOR = 3;

export interface RotationInput {
  token: Address;
  epoch: bigint;
  /** Catalogue version in effect at the epoch's start (`EpochGovernor.poolOf`). */
  version: number;
  bucketSizes: readonly number[];
  categoryMask: bigint;
  regionMask: number;
  /** The pins in effect for the epoch that are not blocked, in order (cause ids). */
  pinned: readonly Hex[];
  /** `EpochGovernor.ballotSize()`. */
  ballotSize: number;
}

export interface RotationDeps {
  /** Org id of catalogue entry `(bucket, index)` of the input's version. */
  entryAt(bucket: number, index: number): Promise<Hex>;
  /** `CauseRegistry.isBlocked(causeId)`. */
  isBlocked(causeId: Hex): Promise<boolean>;
}

/** Cause id of a catalogue org: `keccak256(orgId)` (`CauseRegistry.causeIdOf`). */
export function causeIdOfOrg(orgId: Hex): Hex {
  return keccak256(orgId);
}

/**
 * The entries a correct `prepareBallot` supplies, in draw order, and the ballot they produce.
 * Mirrors `EpochGovernor._prepare`: pins first; then, if the pool fits the free slots, the whole
 * pool in order, else hash draws until the ballot is full or `DRAW_FACTOR * slots` draws are
 * spent, skipping repeats and blocked causes (a skipped draw is still supplied).
 */
export async function planRotation(
  input: RotationInput,
  deps: RotationDeps,
): Promise<{ draws: CatalogEntry[]; options: Hex[]; poolSize: number }> {
  const options: Hex[] = input.pinned.slice(0, input.ballotSize).map((c) => c.toLowerCase() as Hex);
  const draws: CatalogEntry[] = [];
  const size = input.version === 0 ? 0 : poolSize(input.bucketSizes, input.categoryMask, input.regionMask);
  if (size === 0 || options.length >= input.ballotSize) return { draws, options, poolSize: size };
  const slots = input.ballotSize - options.length;
  const sequential = size <= slots;
  const budget = sequential ? size : DRAW_FACTOR * slots;
  for (let k = 0; k < budget && options.length < input.ballotSize; k++) {
    const idx = sequential ? k : drawIndex(input.token, input.epoch, input.version, k, size);
    const { bucket, index } = locate(input.bucketSizes, input.categoryMask, input.regionMask, idx);
    const orgId = await deps.entryAt(bucket, index);
    draws.push({ bucket, index, orgId });
    const causeId = causeIdOfOrg(orgId).toLowerCase() as Hex;
    if (options.includes(causeId) || (await deps.isBlocked(causeId))) continue;
    options.push(causeId);
  }
  return { draws, options, poolSize: size };
}
