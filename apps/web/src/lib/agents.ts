/**
 * Curator agents (`<cause>.agent.<parent>`) from the indexer's public API (`/api/agents/*`).
 * Same conventions as `./indexer`: bigint values arrive and stay as decimal strings, rows that do
 * not parse are dropped, and requests go through `IndexerClient.get` (failover, timeouts, anon
 * routing). Report text is LLM-written from untrusted news: render it as text or with `./markdown`.
 */
import { REGIONS, USDC_DECIMALS, agentByLabel } from "@verada/sdk";
import { IndexerError, type IndexerClient, type TokenFocus } from "./indexer";

/** USDC totals of an agent's vault (6-decimal base units as decimal strings). */
export interface AgentTotals {
  /** Everything donated to the vault. */
  donated: string;
  donations: number;
  /** Everything the vault gave to Endaoment orgs. */
  given: string;
  gifts: number;
}

/** The agent's newest published report. */
export interface AgentLatest {
  epoch: string;
  /** bytes32 Swarm reference of the report. */
  reportRef: string;
  catalogVersion: number;
}

export interface AgentSummary {
  categoryBit: number;
  /** Category slug (`catalog.ts`), or null when the indexer row has a label the app does not know. */
  category: string | null;
  /** Display name of the cause, e.g. "Homelessness". */
  name: string;
  /** ENS label, e.g. `homeless`. */
  label: string;
  /** e.g. `homeless.agent.varada.eth`. */
  ensName: string;
  agentId: string;
  signer: string;
  vault: string;
  active: boolean;
  description: string;
  walletLinked: boolean;
  /** Null when the vault has no activity yet, and always null on `AgentReport.agent`. */
  totals: AgentTotals | null;
  /** From `/api/agents` (the list); on `AgentDetail` it is derived from `reports[0]`; null on `AgentReport.agent`. */
  latest: AgentLatest | null;
}

export interface AgentReportRef {
  epoch: string;
  reportRef: string;
  catalogVersion: number;
  /** Unix seconds. */
  submittedAt?: number;
}

/** On-chain curation of one region for the agent's newest report epoch. */
export interface AgentCuration {
  regionBit: number;
  /** Region slug, or null for an unknown bit. */
  region: string | null;
  count: number;
  weight: number;
  picksRoot: string;
}

/**
 * A donation whose donor opted in to public credit (`donate(amount, true)`). The indexer lists only
 * credited donations; `donor` is still null whenever the row is not explicitly credited, so never
 * show an address that is not on one of these rows (docs/PRIVACY.md).
 */
export interface AgentDonation {
  donor: string | null;
  amount: string;
  timestamp?: number;
  txHash: string;
}

/** A gift from the vault to an Endaoment org. */
export interface AgentGift {
  id: string;
  epoch: string;
  regionBit: number;
  region: string | null;
  /** bytes32 catalogue org id. */
  orgId: string;
  /** Endaoment org contract address. */
  org: string;
  amount: string;
  timestamp?: number;
  txHash: string;
}

export interface AgentDetail extends AgentSummary {
  /** Newest epoch first. */
  reports: AgentReportRef[];
  latestCurations: AgentCuration[];
  /** Credited donations only, newest first. */
  donors: AgentDonation[];
  /** Newest first. */
  gifts: AgentGift[];
}

export interface AgentEvent {
  title: string;
  /** Untrusted: link it only through `safeHttpUrl` / `SafeLink` (`./markdown`). */
  url: string;
  date: string;
  summary: string;
}

export interface AgentPick {
  /** 0-based rank in the region (the order the agent submitted). */
  rank: number;
  orgId: string;
  catalogIndex: number;
  name: string;
  /** 0-100. */
  score: number;
  reasons: string;
  /** Untrusted URLs; link them only through `safeHttpUrl` / `SafeLink`. */
  sources: string[];
}

export interface AgentRegionReport {
  /** Region slug, e.g. `africa`. */
  region: string;
  regionBit: number | null;
  bucket: number | null;
  /** Root the agent submitted on chain for this bucket and epoch; null when none. */
  picksRoot: string | null;
  /** The report's pick tree matches the on-chain root (and pick count). */
  verified: boolean;
  /** Urgency weight, 0-10000. */
  weight: number;
  summary: string;
  events: AgentEvent[];
  /** Ascending by rank. */
  picks: AgentPick[];
  /** Markdown; render with `Markdown` from `./markdown`. */
  newsletter: string;
}

export interface AgentReport {
  agent: AgentSummary;
  epoch: string;
  reportRef: string;
  catalogVersion: number;
  title: string;
  intro: string;
  generatedAt: string;
  regions: AgentRegionReport[];
}

type Getter = Pick<IndexerClient, "get">;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Decimal string for bigint-ish values (the indexer sends bigints as strings). */
function dec(v: unknown): string {
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v === "bigint" && v >= 0n) return v.toString();
  return "0";
}

const list = <T>(v: unknown, f: (x: unknown, i: number) => T | null): T[] =>
  Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [];

const strList = (v: unknown): string[] => list(v, (x) => (typeof x === "string" ? x : null));

const regionSlug = (bit: number) => REGIONS.find((r) => r.bit === bit)?.slug ?? null;

function toTotals(v: unknown): AgentTotals | null {
  if (!isRecord(v)) return null;
  return { donated: dec(v.donated), donations: num(v.donations) ?? 0, given: dec(v.given), gifts: num(v.gifts) ?? 0 };
}

function toLatest(v: unknown): AgentLatest | null {
  if (!isRecord(v) || v.epoch === undefined || v.epoch === null) return null;
  return { epoch: dec(v.epoch), reportRef: str(v.reportRef) ?? "", catalogVersion: num(v.catalogVersion) ?? 0 };
}

export function toAgentSummary(v: unknown): AgentSummary | null {
  if (!isRecord(v) || typeof v.label !== "string") return null;
  const categoryBit = num(v.categoryBit);
  if (categoryBit === undefined) return null;
  const def = agentByLabel(v.label);
  return {
    categoryBit,
    category: str(v.category) ?? def?.slug ?? null,
    name: str(v.name) ?? def?.label ?? v.label,
    label: v.label.toLowerCase(),
    ensName: str(v.ensName) ?? "",
    agentId: dec(v.agentId),
    signer: str(v.signer) ?? "",
    vault: str(v.vault) ?? "",
    active: v.active === true,
    description: str(v.description) ?? "",
    walletLinked: v.walletLinked === true,
    totals: toTotals(v.totals),
    latest: toLatest(v.latest),
  };
}

function toReportRef(v: unknown): AgentReportRef | null {
  if (!isRecord(v) || v.epoch === undefined) return null;
  return { epoch: dec(v.epoch), reportRef: str(v.reportRef) ?? "", catalogVersion: num(v.catalogVersion) ?? 0, submittedAt: num(v.submittedAt) };
}

function toCuration(v: unknown): AgentCuration | null {
  if (!isRecord(v)) return null;
  const regionBit = num(v.regionBit);
  if (regionBit === undefined) return null;
  return { regionBit, region: regionSlug(regionBit), count: num(v.count) ?? 0, weight: num(v.weight) ?? 0, picksRoot: str(v.picksRoot) ?? "" };
}

function toDonation(v: unknown): AgentDonation | null {
  if (!isRecord(v)) return null;
  // Privacy: an address is shown only for a donation credited on chain. The route lists credited
  // donations only; a row that says otherwise keeps its amount but loses the address.
  const donor = v.credit === false ? null : (str(v.donor) ?? null);
  return { donor, amount: dec(v.amount), timestamp: num(v.timestamp), txHash: str(v.txHash) ?? "" };
}

function toGift(v: unknown): AgentGift | null {
  if (!isRecord(v)) return null;
  const regionBit = num(v.regionBit);
  if (regionBit === undefined) return null;
  return {
    id: str(v.id) ?? "",
    epoch: dec(v.epoch),
    regionBit,
    region: regionSlug(regionBit),
    orgId: str(v.orgId) ?? "",
    org: str(v.org) ?? "",
    amount: dec(v.amount),
    timestamp: num(v.timestamp),
    txHash: str(v.txHash) ?? "",
  };
}

export function toAgentDetail(v: unknown): AgentDetail | null {
  const a = toAgentSummary(v);
  if (!a || !isRecord(v)) return null;
  const reports = list(v.reports, toReportRef);
  const first = reports[0];
  return {
    ...a,
    latest: a.latest ?? (first ? { epoch: first.epoch, reportRef: first.reportRef, catalogVersion: first.catalogVersion } : null),
    reports,
    latestCurations: list(v.latestCurations, toCuration),
    donors: list(v.donors, toDonation),
    gifts: list(v.gifts, toGift),
  };
}

function toEvent(v: unknown): AgentEvent | null {
  if (!isRecord(v)) return null;
  return { title: str(v.title) ?? "", url: str(v.url) ?? "", date: str(v.date) ?? "", summary: str(v.summary) ?? "" };
}

function toPick(v: unknown, i: number): AgentPick | null {
  if (!isRecord(v) || typeof v.orgId !== "string") return null;
  const score = num(v.score) ?? 0;
  return {
    rank: num(v.rank) ?? i,
    orgId: v.orgId,
    catalogIndex: num(v.catalogIndex) ?? 0,
    name: str(v.name) ?? v.orgId,
    score: Math.max(0, Math.min(100, score)),
    reasons: str(v.reasons) ?? "",
    sources: strList(v.sources),
  };
}

function toRegionReport(v: unknown): AgentRegionReport | null {
  if (!isRecord(v) || typeof v.region !== "string") return null;
  return {
    region: v.region,
    regionBit: num(v.regionBit) ?? null,
    bucket: num(v.bucket) ?? null,
    picksRoot: str(v.picksRoot) ?? null,
    verified: v.verified === true,
    weight: num(v.weight) ?? 0,
    summary: str(v.summary) ?? "",
    events: list(v.events, toEvent),
    picks: list(v.picks, toPick).sort((a, b) => a.rank - b.rank),
    newsletter: str(v.newsletter) ?? "",
  };
}

export function toAgentReport(v: unknown): AgentReport | null {
  if (!isRecord(v) || v.epoch === undefined) return null;
  const agent = toAgentSummary(v.agent);
  if (!agent) return null;
  return {
    agent,
    epoch: dec(v.epoch),
    reportRef: str(v.reportRef) ?? "",
    catalogVersion: num(v.catalogVersion) ?? 0,
    title: str(v.title) ?? "",
    intro: str(v.intro) ?? "",
    generatedAt: str(v.generatedAt) ?? "",
    regions: list(v.regions, toRegionReport),
  };
}

/** Null on 404 (unknown agent, epoch or report) and 400 (rejected label or epoch). */
async function orMissing<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IndexerError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/** Every registered agent, by category bit. Throws on indexer errors (503 `agents_unavailable` included). */
export async function listAgents(client: Getter): Promise<AgentSummary[]> {
  const body = await client.get("/api/agents");
  const items = isRecord(body) ? body.items : body;
  return list(items, toAgentSummary).sort((a, b) => a.categoryBit - b.categoryBit);
}

/** An agent with totals, report history, latest curations, credited donors and gifts; null when unknown. */
export async function getAgent(client: Getter, label: string): Promise<AgentDetail | null> {
  const l = label.trim().toLowerCase();
  if (!agentByLabel(l)) return null;
  return orMissing(async () => toAgentDetail(await client.get(`/api/agents/${encodeURIComponent(l)}`)));
}

/** An agent's report for one epoch, regions verified against the on-chain roots; null when there is none. */
export async function getAgentReport(client: Getter, label: string, epoch: string | number | bigint): Promise<AgentReport | null> {
  const l = label.trim().toLowerCase();
  const e = String(epoch);
  if (!agentByLabel(l) || !/^\d+$/.test(e)) return null;
  return orMissing(async () => toAgentReport(await client.get(`/api/agents/${encodeURIComponent(l)}/reports/${e}`)));
}

/** Agents whose category is in a token's focus (by slug, or by bit when the slug list is empty). */
export function agentsForFocus<T extends Pick<AgentSummary, "category" | "categoryBit">>(
  agents: readonly T[],
  focus: Pick<TokenFocus, "categories" | "categoryMask"> | null | undefined,
): T[] {
  if (!focus) return [];
  if (focus.categories.length > 0) {
    const slugs = new Set(focus.categories);
    return agents.filter((a) => a.category !== null && slugs.has(a.category));
  }
  const mask = /^\d+$/.test(focus.categoryMask) ? BigInt(focus.categoryMask) : 0n;
  return agents.filter((a) => (mask >> BigInt(a.categoryBit)) & 1n);
}

/** One region of a report, or null. */
export function regionReport(report: Pick<AgentReport, "regions"> | null | undefined, regionSlug: string): AgentRegionReport | null {
  return report?.regions.find((r) => r.region === regionSlug) ?? null;
}

/** A region's picks, ascending by rank; empty when the report has no such region. */
export function regionPicks(report: Pick<AgentReport, "regions"> | null | undefined, regionSlug: string): AgentPick[] {
  return regionReport(report, regionSlug)?.picks ?? [];
}

/**
 * USDC base units (6 decimals) as a display string with thousands separators and at most
 * `maxDecimals` (default 2) decimals, truncated: 1234567890n -> "1,234.56". Invalid input -> "0".
 */
export function formatUsdc(amount: bigint | string, maxDecimals = 2): string {
  let v: bigint;
  if (typeof amount === "bigint") v = amount;
  else if (/^\d+$/.test(amount.trim())) v = BigInt(amount.trim());
  else return "0";
  const neg = v < 0n;
  if (neg) v = -v;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = (v / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const digits = Math.max(0, Math.min(USDC_DECIMALS, Math.floor(maxDecimals)));
  const frac = (v % unit).toString().padStart(USDC_DECIMALS, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** In-app route of an agent page: `/agent/<label>/`, or `/agent/<label>/<region>/` for one region. */
export function agentPath(label: string, region?: string): string {
  const base = `/agent/${encodeURIComponent(label.trim().toLowerCase())}/`;
  return region ? `${base}${encodeURIComponent(region)}/` : base;
}
