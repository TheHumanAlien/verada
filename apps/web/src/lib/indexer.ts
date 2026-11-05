/** Client for the indexer HTTP API: JSON, cursor pagination, bigint values as decimal strings. */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TokenSummary {
  address: string;
  name: string;
  symbol: string;
  creator?: string;
  feeBps?: number;
  metadataURI?: string;
}

export const ACTIVITY_KINDS = ["launch", "fees", "consolidated", "donation", "vote", "epoch"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  id: string;
  kind: string;
  token?: string;
  timestamp?: number;
  txHash?: string;
  /** Kind-specific payload; bigint values arrive as decimal strings. */
  data: Record<string, unknown>;
}

export interface CauseSummary {
  name: string;
  causeId: string;
  orgId: string | null;
  address: string | null;
  isDeployed: boolean;
}

export interface EpochSummary {
  epoch: string;
  [key: string]: unknown;
}

export interface Stats {
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(BigInt(v));
  return undefined;
}

export function toToken(v: unknown): TokenSummary | null {
  if (!isRecord(v) || typeof v.address !== "string") return null;
  return {
    address: v.address,
    name: str(v.name) ?? "",
    symbol: str(v.symbol) ?? "",
    creator: str(v.creator),
    feeBps: typeof v.feeBps === "number" ? v.feeBps : undefined,
    metadataURI: str(v.metadataUri) ?? str(v.metadataURI),
  };
}

export function toActivity(v: unknown): ActivityItem | null {
  if (!isRecord(v) || v.id === undefined || typeof v.kind !== "string") return null;
  const { id, kind, token, timestamp, txHash, ...rest } = v;
  return {
    id: String(id),
    kind,
    token: str(token),
    timestamp: toSeconds(timestamp),
    txHash: str(txHash),
    data: isRecord(v.data) ? v.data : rest,
  };
}

/** Search results carry `id`; /api/causes rows carry `causeId`. */
export function toCause(v: unknown): CauseSummary | null {
  if (!isRecord(v)) return null;
  const id = str(v.id) ?? str(v.causeId);
  if (id === undefined) return null;
  return {
    name: str(v.name) ?? id,
    causeId: id,
    orgId: str(v.orgId) ?? null,
    address: str(v.address) ?? str(v.payout) ?? null,
    isDeployed: v.isDeployed === true || v.active === true,
  };
}

/** Tolerates `{items, nextCursor}`, a keyed list, or a bare array. */
export function toPage<T>(body: unknown, map: (v: unknown) => T | null): Page<T> {
  const raw = Array.isArray(body)
    ? body
    : isRecord(body)
      ? (Object.values(body).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  const cursor = isRecord(body) ? (body.nextCursor ?? body.next) : null;
  return {
    items: raw.map(map).filter((x): x is T => x !== null),
    nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
  };
}

export class IndexerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface IndexerClientOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout; a function is re-read on every request (e.g. longer while routed through a mixnet). */
  timeoutMs?: number | (() => number);
}

export class IndexerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: () => number;
  /** Index of the last base URL that answered; tried first next time. */
  private preferred = 0;

  constructor(
    readonly baseUrls: string[],
    opts: IndexerClientOptions = {},
  ) {
    if (baseUrls.length === 0) throw new Error("No indexer URLs configured");
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    const t = opts.timeoutMs ?? 8000;
    this.timeoutMs = typeof t === "function" ? t : () => t;
  }

  /** GET with failover. 4xx answers are definitive (no failover); network errors and 5xx fail over. */
  async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const suffix = `${path}${qs.size ? `?${qs}` : ""}`;
    let lastError: unknown;
    for (let i = 0; i < this.baseUrls.length; i++) {
      const idx = (this.preferred + i) % this.baseUrls.length;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs());
      try {
        const res = await this.fetchImpl(`${this.baseUrls[idx]}${suffix}`, {
          headers: { accept: "application/json" },
          signal: ctl.signal,
        });
        if (res.status >= 500) {
          lastError = new IndexerError(`Indexer responded ${res.status}`, res.status);
          continue;
        }
        if (!res.ok) throw new IndexerError(`Indexer responded ${res.status}`, res.status);
        this.preferred = idx;
        return await res.json();
      } catch (e) {
        if (e instanceof IndexerError) throw e;
        lastError = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new IndexerError("Indexer unreachable");
  }

  async health(): Promise<boolean> {
    try {
      await this.get("/health");
      return true;
    } catch {
      return false;
    }
  }

  async tokens(opts: { cursor?: string; limit?: number } = {}): Promise<Page<TokenSummary>> {
    return toPage(await this.get("/api/tokens", opts), toToken);
  }

  async token(address: string): Promise<TokenSummary | null> {
    try {
      return toToken(await this.get(`/api/tokens/${address}`));
    } catch (e) {
      if (e instanceof IndexerError && e.status === 404) return null;
      throw e;
    }
  }

  async activity(opts: { cursor?: string; limit?: number; token?: string; kind?: ActivityKind } = {}): Promise<Page<ActivityItem>> {
    return toPage(await this.get("/api/activity", opts), toActivity);
  }

  async causes(opts: { cursor?: string; limit?: number } = {}): Promise<Page<CauseSummary>> {
    return toPage(await this.get("/api/causes", opts), toCause);
  }

  async searchCauses(q: string, cursor?: string): Promise<Page<CauseSummary>> {
    return toPage(await this.get("/api/causes/search", { q, cursor }), toCause);
  }

  async epochs(token: string): Promise<unknown> {
    return this.get(`/api/epochs/${token}`);
  }

  async epoch(token: string, epoch: string | number): Promise<unknown> {
    return this.get(`/api/epochs/${token}/${epoch}`);
  }

  async stats(): Promise<Stats> {
    const body = await this.get("/api/stats");
    return isRecord(body) ? body : {};
  }

  streamUrl(index = this.preferred): string {
    return `${this.baseUrls[index % this.baseUrls.length]}/api/activity/stream`;
  }
}

/** Display label: "Name (SYM)" when known, otherwise a shortened address. */
export function label(t: Pick<TokenSummary, "address" | "name" | "symbol">): string {
  if (t.name || t.symbol) return `${t.name}${t.symbol ? ` (${t.symbol})` : ""}`.trim();
  return t.address.length > 12 ? `${t.address.slice(0, 6)}...${t.address.slice(-4)}` : t.address;
}
