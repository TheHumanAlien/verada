import {
  EndaomentClient,
  type Cache,
  getMainnetDeployment,
  toOrgId,
  type OrgSearchListing,
} from "@verada/endaoment-client";

/** Bounded TTL cache (insertion-ordered eviction) for upstream responses. */
export class BoundedTtlCache implements Cache {
  private store = new Map<string, { value: unknown; expires: number }>();
  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): unknown | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.store.delete(key);
    this.store.set(key, { value, expires: this.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      const first = this.store.keys().next().value;
      if (first === undefined) break;
      this.store.delete(first);
    }
  }
}

/** Whitelisted public shape. No image or logo URLs, no free-text descriptions. */
export interface CauseSearchResult {
  id: string;
  name: string;
  orgId: string | null;
  address: string | null;
  isDeployed: boolean;
}

export function toResult(o: OrgSearchListing): CauseSearchResult {
  let orgId: string | null = null;
  try {
    orgId = toOrgId(o);
  } catch {
    orgId = null;
  }
  let address: string | null = null;
  let isDeployed = false;
  try {
    const d = getMainnetDeployment(o);
    if (d) {
      address = d.address;
      isDeployed = d.isDeployed;
    }
  } catch {
    // malformed upstream address: leave unresolved
  }
  return { id: o.id, name: o.name, orgId, address, isDeployed };
}

export interface CauseSearch {
  search(q: string, offset: number, count: number): Promise<CauseSearchResult[]>;
}

export function createCauseSearch(opts: {
  baseUrl?: string;
  apiKey?: string;
  ttlMs: number;
  maxEntries: number;
  fetch?: typeof fetch;
}): CauseSearch {
  const client = new EndaomentClient({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetch: opts.fetch,
    cache: new BoundedTtlCache(opts.maxEntries),
    cacheTtlMs: opts.ttlMs,
    maxRetries: 2,
  });
  return {
    async search(q, offset, count) {
      const rows = await client.searchOrganizations({ searchTerm: q, offset, count });
      return rows.map(toResult);
    },
  };
}
