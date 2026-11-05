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
  /** ENS label (`<label>.<parent>`), when the indexer has the profile. */
  label?: string;
  controller?: string;
  editor?: string;
  logoRef?: string;
  contenthash?: string;
  suppressed?: boolean;
}

/** `TokenProfileRegistry` profile of a token, from the indexer or the chain. */
export interface TokenProfile {
  label: string | null;
  labelhash?: string;
  controller: string | null;
  editor: string | null;
  /** bytes32 Swarm reference, or null when unset. */
  logoRef: string | null;
  /** Contenthash override, or null when the default applies. */
  contenthash: string | null;
  suppressed: boolean;
  registeredAt?: number;
  textRecords: Record<string, string>;
}

/** A token's cause focus, fixed at launch: the catalogue categories and regions its ballots draw from. */
export interface TokenFocus {
  /** uint64 category bit mask as a decimal string. */
  categoryMask: string;
  regionMask: number;
  categories: string[];
  regions: string[];
}

export interface TokenDetail extends TokenSummary {
  profile: TokenProfile | null;
  /** Causes the controller pinned (they lead every ballot); null when none. */
  shortlist: string[] | null;
  /** Null when not known yet. */
  focus: TokenFocus | null;
}

/** A catalogue org (`/api/catalog/*`). */
export interface CatalogOrg {
  orgId: string;
  causeId: string;
  ein: string | null;
  name: string;
  country: string | null;
  state: string | null;
  nteeCode: string | null;
  categories: string[];
  regions: string[];
}

export interface CatalogEntry {
  bucket: number;
  index: number;
  orgId: string;
  proof: string[];
}

export interface CatalogSummary {
  root: string;
  orgs: number;
  entries: number;
  categories: { slug: string; label: string; bit: number; orgs: number }[];
  regions: { slug: string; label: string; bit: number; orgs: number }[];
}

export interface PollSummary {
  opened: boolean;
  closed: boolean;
  isFinal: boolean;
  optionCount: number;
  /** Decrypted per-option totals (whole tokens), once final. */
  counts: string[] | null;
  ballotCount: number;
  scheme?: string;
}

export interface EpochDetail {
  epoch: string;
  options: string[];
  poll: PollSummary | null;
  voterCount?: number;
  start?: number;
  end?: number;
  snapshot?: number;
  winningCause?: string | null;
  finalized?: boolean;
  /** The ballot is fixed (pins plus rotation draws); voting needs it. */
  prepared?: boolean;
  /** Focus pool size the ballot was drawn from. */
  poolSize?: string;
  [key: string]: unknown;
}

export interface TakeoverItem {
  proposalId: string;
  token: string;
  proposer: string;
  newController: string;
  start?: number;
  end?: number;
  executionDeadline?: number;
  snapshot?: number;
  /** `snapshot - lookback`: weights are the smaller of the votes at both points. */
  lookbackSnapshot?: number;
  quorumWeight: string;
  /** Circulating supply at the snapshot (whole tokens); quorum is a share of it. */
  circulatingWeight?: string;
  forWeight: string;
  againstWeight: string;
  closed: boolean;
  tallied: boolean;
  executed: boolean;
  canceled: boolean;
  ballotCount: number;
  state: string;
}

export interface QuoteAssetRow {
  asset: string;
  kind?: number;
  active: boolean;
  decimals?: number;
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

const bool = (v: unknown) => v === true;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Decimal string for bigint-ish values (the indexer sends bigints as strings). */
function dec(v: unknown): string {
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v === "bigint") return v.toString();
  return "0";
}

function strList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

const ZERO_BYTES32 = /^0x0{64}$/i;
const ZERO_ADDRESS = /^0x0{40}$/i;

/** Null for missing, empty or all-zero values. */
function nonZero(v: unknown, zero: RegExp): string | null {
  const s = str(v);
  return s && s !== "0x" && !zero.test(s) ? s : null;
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
    label: str(v.label),
    controller: nonZero(v.controller, ZERO_ADDRESS) ?? undefined,
    editor: nonZero(v.editor, ZERO_ADDRESS) ?? undefined,
    logoRef: nonZero(v.logoRef, ZERO_BYTES32) ?? undefined,
    contenthash: nonZero(v.contenthash, ZERO_BYTES32) ?? undefined,
    suppressed: typeof v.suppressed === "boolean" ? v.suppressed : undefined,
  };
}

export function toProfile(v: unknown): TokenProfile | null {
  if (!isRecord(v)) return null;
  const texts: Record<string, string> = {};
  if (isRecord(v.textRecords)) {
    for (const [k, val] of Object.entries(v.textRecords)) if (typeof val === "string" && val !== "") texts[k] = val;
  }
  return {
    label: str(v.label) ?? null,
    labelhash: str(v.labelhash),
    controller: nonZero(v.controller, ZERO_ADDRESS),
    editor: nonZero(v.editor, ZERO_ADDRESS),
    logoRef: nonZero(v.logoRef, ZERO_BYTES32),
    contenthash: nonZero(v.contenthash, ZERO_BYTES32),
    suppressed: bool(v.suppressed),
    registeredAt: num(v.registeredAt),
    textRecords: texts,
  };
}

/** Token detail; the profile falls back to the list-level fields when `profile` is absent. */
export function toTokenDetail(v: unknown): TokenDetail | null {
  const t = toToken(v);
  if (!t || !isRecord(v)) return null;
  let profile = toProfile(v.profile);
  if (!profile && t.label) {
    profile = {
      label: t.label,
      controller: t.controller ?? null,
      editor: t.editor ?? null,
      logoRef: t.logoRef ?? null,
      contenthash: t.contenthash ?? null,
      suppressed: t.suppressed ?? false,
      textRecords: {},
    };
  }
  return { ...t, profile, shortlist: strList(v.shortlist), focus: toFocus(v.focus) };
}

function toFocus(v: unknown): TokenFocus | null {
  if (!isRecord(v)) return null;
  const regionMask = num(v.regionMask);
  if (v.categoryMask === undefined || regionMask === undefined) return null;
  return { categoryMask: dec(v.categoryMask), regionMask, categories: strList(v.categories) ?? [], regions: strList(v.regions) ?? [] };
}

function toCatalogOrg(v: unknown): CatalogOrg | null {
  if (!isRecord(v) || typeof v.causeId !== "string" || typeof v.orgId !== "string") return null;
  return {
    orgId: v.orgId,
    causeId: v.causeId.toLowerCase(),
    ein: str(v.ein) ?? null,
    name: str(v.name) ?? v.causeId,
    country: str(v.country) ?? null,
    state: str(v.state) ?? null,
    nteeCode: str(v.nteeCode) ?? null,
    categories: strList(v.categories) ?? [],
    regions: strList(v.regions) ?? [],
  };
}

function toCatalogEntry(v: unknown): CatalogEntry | null {
  if (!isRecord(v) || typeof v.orgId !== "string") return null;
  const bucket = num(v.bucket);
  const index = num(v.index);
  if (bucket === undefined || index === undefined) return null;
  return { bucket, index, orgId: v.orgId, proof: strList(v.proof) ?? [] };
}

const items = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
  isRecord(v) && Array.isArray(v.items) ? v.items.map(f).filter((x): x is T => x !== null) : [];

export function toEpochDetail(v: unknown): EpochDetail | null {
  if (!isRecord(v) || v.epoch === undefined) return null;
  const p = isRecord(v.poll) ? v.poll : null;
  return {
    ...v,
    epoch: dec(v.epoch),
    options: strList(v.options) ?? [],
    poll: p && {
      opened: bool(p.opened),
      closed: bool(p.closed),
      isFinal: bool(p.isFinal),
      optionCount: num(p.optionCount) ?? 0,
      counts: Array.isArray(p.counts) ? p.counts.map(dec) : null,
      ballotCount: num(p.ballotCount) ?? 0,
      scheme: str(p.scheme),
    },
    voterCount: num(v.voterCount),
    start: num(v.start),
    end: num(v.end),
    snapshot: num(v.snapshot),
    winningCause: nonZero(v.winningCause ?? v.winner, ZERO_BYTES32),
    finalized: typeof v.finalized === "boolean" ? v.finalized : undefined,
    prepared: bool(v.prepared) || (strList(v.options) ?? []).length > 0,
    poolSize: v.poolSize === undefined || v.poolSize === null ? undefined : dec(v.poolSize),
  };
}

/** `ITakeoverGovernor.State`, in enum order. `Superseded`: a newer proposal for the token was executed. */
export const TAKEOVER_STATES = ["None", "Active", "Closing", "Defeated", "Succeeded", "Executed", "Canceled", "Expired", "Superseded"] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

/** Accepts the numeric enum or its name (any case). */
export function takeoverStateName(v: unknown): TakeoverState | "Unknown" {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) return TAKEOVER_STATES[Number(v)] ?? "Unknown";
  if (typeof v === "string") return TAKEOVER_STATES.find((s) => s.toLowerCase() === v.toLowerCase()) ?? "Unknown";
  return "Unknown";
}

export function toTakeover(v: unknown): TakeoverItem | null {
  if (!isRecord(v) || v.proposalId === undefined) return null;
  return {
    proposalId: dec(v.proposalId),
    token: str(v.token) ?? "",
    proposer: str(v.proposer) ?? "",
    newController: str(v.newController) ?? "",
    start: num(v.start),
    end: num(v.end),
    executionDeadline: num(v.executionDeadline),
    snapshot: num(v.snapshot),
    lookbackSnapshot: num(v.lookbackSnapshot),
    quorumWeight: dec(v.quorumWeight),
    circulatingWeight: v.circulatingWeight === undefined || v.circulatingWeight === null ? undefined : dec(v.circulatingWeight),
    forWeight: dec(v.forWeight),
    againstWeight: dec(v.againstWeight),
    closed: bool(v.closed),
    tallied: bool(v.tallied),
    executed: bool(v.executed),
    canceled: bool(v.canceled),
    ballotCount: num(v.ballotCount) ?? 0,
    state: takeoverStateName(v.state),
  };
}

export function toQuoteAsset(v: unknown): QuoteAssetRow | null {
  if (!isRecord(v)) return null;
  const asset = str(v.asset) ?? str(v.address);
  if (!asset) return null;
  return { asset, kind: num(v.kind), active: v.active !== false, decimals: num(v.decimals) };
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

  /** Token with its profile and shortlists; null when unknown. */
  async tokenDetail(address: string): Promise<TokenDetail | null> {
    return this.orNull(async () => toTokenDetail(await this.get(`/api/tokens/${address}`)));
  }

  /** Token by ENS label; null when no token has it. */
  async tokenByLabel(label: string): Promise<TokenDetail | null> {
    return this.orNull(async () => toTokenDetail(await this.get(`/api/tokens/by-label/${encodeURIComponent(label)}`)));
  }

  async epochDetail(token: string, epoch: string | number | bigint): Promise<EpochDetail | null> {
    return this.orNull(async () => toEpochDetail(await this.get(`/api/epochs/${token}/${epoch}`)));
  }

  async takeovers(token: string): Promise<TakeoverItem[]> {
    return toPage(await this.get(`/api/takeovers/${token}`), toTakeover).items;
  }

  /** Allowlisted quote assets (root-level legacy route). */
  async quoteAssets(): Promise<QuoteAssetRow[]> {
    return toPage(await this.get("/quote-assets", { active: "true" }), toQuoteAsset).items;
  }

  private async orNull<T>(fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
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

  /** Catalogue summary with per-category and per-region org counts; null without a catalogue. */
  async catalog(): Promise<CatalogSummary | null> {
    return this.orUnavailable(async () => {
      const v = await this.get("/api/catalog");
      if (!isRecord(v) || !Array.isArray(v.categories) || !Array.isArray(v.regions)) return null;
      return v as unknown as CatalogSummary;
    });
  }

  async catalogSearch(q: { q?: string; categories?: string[]; regions?: string[]; offset?: number; limit?: number }): Promise<{ items: CatalogOrg[]; total: number } | null> {
    return this.orUnavailable(async () => {
      const v = await this.get("/api/catalog/search", {
        q: q.q || undefined,
        categories: q.categories?.length ? q.categories.join(",") : undefined,
        regions: q.regions?.length ? q.regions.join(",") : undefined,
        offset: q.offset,
        limit: q.limit,
      });
      return { items: items(v, toCatalogOrg), total: isRecord(v) ? num(v.total) ?? 0 : 0 };
    });
  }

  /** Size of a focus pool (all categories / regions when a list is empty). */
  async catalogPool(categories: string[], regions: string[]): Promise<number | null> {
    return this.orUnavailable(async () => {
      const v = await this.get("/api/catalog/pool", {
        categories: categories.length ? categories.join(",") : undefined,
        regions: regions.length ? regions.join(",") : undefined,
      });
      return isRecord(v) ? num(v.poolSize) ?? 0 : 0;
    });
  }

  /** An org and its catalogue entries with proofs, by org id, cause id, EIN or Endaoment id. */
  async catalogOrg(id: string): Promise<{ org: CatalogOrg; entries: CatalogEntry[] } | null> {
    return this.orUnavailable(async () =>
      this.orNull(async () => {
        const v = await this.get(`/api/catalog/orgs/${encodeURIComponent(id)}`);
        const org = isRecord(v) ? toCatalogOrg(v.org) : null;
        if (!org || !isRecord(v) || !Array.isArray(v.entries)) return null;
        return { org, entries: v.entries.map(toCatalogEntry).filter((e): e is CatalogEntry => e !== null) };
      }),
    );
  }

  /** Catalogue orgs by cause id, keyed by lowercase cause id. */
  async catalogCauses(causeIds: string[]): Promise<Map<string, CatalogOrg>> {
    const out = new Map<string, CatalogOrg>();
    const ids = [...new Set(causeIds.map((c) => c.toLowerCase()))];
    for (let i = 0; i < ids.length; i += 50) {
      const v = await this.orUnavailable(() => this.get("/api/catalog/causes", { ids: ids.slice(i, i + 50).join(",") }));
      for (const o of items(v, toCatalogOrg)) out.set(o.causeId, o);
    }
    return out;
  }

  /** Null instead of throwing when the indexer has no catalogue loaded (503). */
  private async orUnavailable<T>(fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof IndexerError && e.status === 503) return null;
      throw e;
    }
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
