import { entryProof, loadCatalog, type BuiltCatalog, type CatalogOrg } from "@verada/cause-catalog";
import {
  CATEGORIES,
  REGIONS,
  bucketParts,
  focusBuckets,
  type CatalogEntry,
} from "@verada/sdk";
import type { Hex } from "viem";

/** The public shape of a catalogue org: no descriptions, no image URLs. */
export interface CatalogOrgResult {
  orgId: Hex;
  causeId: Hex;
  ein: string | null;
  name: string;
  country: string | null;
  state: string | null;
  nteeCode: string | null;
  claimed: boolean;
  categories: string[];
  regions: string[];
}

export interface CatalogEntryWithProof extends CatalogEntry {
  proof: Hex[];
}

export interface CatalogSearch {
  q?: string;
  categoryMask?: bigint;
  regionMask?: number;
  offset: number;
  limit: number;
}

/** Read access to the published cause catalogue, loaded once into memory. */
export interface CatalogStore {
  /** Null until loaded (or when no source is configured, or loading failed). */
  catalog(): BuiltCatalog | null;
  search(q: CatalogSearch): { items: CatalogOrgResult[]; total: number } | null;
  /** Orgs by cause id (`keccak256(orgId)`); unknown ids are omitted. */
  causes(causeIds: Hex[]): CatalogOrgResult[] | null;
  /** By org id or cause id (hex), EIN (hyphen optional) or Endaoment id. */
  org(id: string): { org: CatalogOrgResult; entries: CatalogEntryWithProof[] } | null | undefined;
  /** Entries by `(bucket, index)`, with proofs; unknown entries are omitted. */
  entries(at: { bucket: number; index: number }[]): CatalogEntryWithProof[] | null;
  pool(categoryMask: bigint, regionMask: number): { poolSize: number; buckets: { bucket: number; category: string; region: string; size: number }[] } | null;
}

const toResult = (o: CatalogOrg): CatalogOrgResult => ({
  orgId: o.orgId,
  causeId: o.causeId,
  ein: o.ein,
  name: o.name,
  country: o.country,
  state: o.state,
  nteeCode: o.nteeCode,
  claimed: o.claimed,
  categories: o.categories,
  regions: o.regions,
});

const slugOfCategory = (bit: number) => CATEGORIES.find((c) => c.bit === bit)?.slug ?? `category-${bit}`;
const slugOfRegion = (bit: number) => REGIONS.find((r) => r.bit === bit)?.slug ?? `region-${bit}`;

/** Builds the in-memory indexes over a loaded catalogue. Exported for tests. */
export function catalogStoreOf(c: BuiltCatalog | null): CatalogStore {
  if (!c) {
    return { catalog: () => null, search: () => null, causes: () => null, org: () => null, entries: () => null, pool: () => null };
  }
  const names = c.orgs.map((o) => o.name.toLowerCase());
  const masks = c.orgs.map((o) => ({ c: BigInt(o.categoryMask), r: o.regionMask }));
  const byKey = new Map<string, number>();
  c.orgs.forEach((o, i) => {
    byKey.set(o.orgId.toLowerCase(), i);
    byKey.set(o.causeId.toLowerCase(), i);
    byKey.set(o.id.toLowerCase(), i);
    if (o.ein) byKey.set(o.ein.replace(/-/g, ""), i);
  });
  const orgAt = new Map<string, Hex>();
  for (const [, [bucket, index, orgId]] of c.tree.entries()) orgAt.set(`${bucket}:${index}`, orgId);
  const withProof = (e: CatalogEntry): CatalogEntryWithProof => ({ ...e, proof: entryProof(c.tree, e) });

  return {
    catalog: () => c,
    search(q) {
      const needle = q.q?.trim().toLowerCase();
      const out: CatalogOrgResult[] = [];
      let total = 0;
      for (let i = 0; i < c.orgs.length; i++) {
        if (q.categoryMask !== undefined && (masks[i]!.c & q.categoryMask) === 0n) continue;
        if (q.regionMask !== undefined && (masks[i]!.r & q.regionMask) === 0) continue;
        if (needle && !names[i]!.includes(needle)) continue;
        if (total >= q.offset && out.length < q.limit) out.push(toResult(c.orgs[i]!));
        total++;
      }
      return { items: out, total };
    },
    causes(causeIds) {
      const out: CatalogOrgResult[] = [];
      for (const id of causeIds) {
        const i = byKey.get(id.toLowerCase());
        if (i !== undefined && c.orgs[i]!.causeId.toLowerCase() === id.toLowerCase()) out.push(toResult(c.orgs[i]!));
      }
      return out;
    },
    org(id) {
      const key = id.trim().toLowerCase().replace(/^(\d{2})-(\d{7})$/, "$1$2");
      const i = byKey.get(key);
      if (i === undefined) return undefined;
      const o = c.orgs[i]!;
      return { org: toResult(o), entries: o.entries.map((e) => withProof({ ...e, orgId: o.orgId })) };
    },
    entries(at) {
      const out: CatalogEntryWithProof[] = [];
      for (const { bucket, index } of at) {
        const orgId = orgAt.get(`${bucket}:${index}`);
        if (orgId) out.push(withProof({ bucket, index, orgId }));
      }
      return out;
    },
    pool(categoryMask, regionMask) {
      const buckets = focusBuckets(c.meta.bucketSizes, categoryMask, regionMask).map(({ bucket, size }) => {
        const { categoryBit, regionBit } = bucketParts(bucket);
        return { bucket, category: slugOfCategory(categoryBit), region: slugOfRegion(regionBit), size };
      });
      return { poolSize: buckets.reduce((n, b) => n + b.size, 0), buckets };
    },
  };
}

/**
 * Loads the catalogue from `source` in the background and swaps it in when ready. Without a
 * source every call answers null (the routes return 503). Load errors are logged by name only.
 */
export function createCatalogStore(
  source: string | undefined,
  opts: { fetch?: typeof fetch; log?: (msg: string) => void } = {},
): CatalogStore & { ready: Promise<void> } {
  let store = catalogStoreOf(null);
  const ready = source
    ? loadCatalog(source, opts.fetch)
        .then((c) => {
          store = catalogStoreOf(c);
          opts.log?.(`catalogue loaded: ${c.orgs.length} orgs, root ${c.meta.root}`);
        })
        .catch((e: unknown) => {
          opts.log?.(`catalogue load failed: ${e instanceof Error ? e.name : "unknown"}`);
        })
    : Promise.resolve();
  return {
    ready,
    catalog: () => store.catalog(),
    search: (q) => store.search(q),
    causes: (ids) => store.causes(ids),
    org: (id) => store.org(id),
    entries: (at) => store.entries(at),
    pool: (cm, rm) => store.pool(cm, rm),
  };
}
