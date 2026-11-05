import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EndaomentClient, MAX_PAGE_SIZE, getMainnetDeployment, type OrgSearchListing } from "@verada/endaoment-client";

/** NTEE major groups. Every org with a code falls in exactly one, so they partition the crawl. */
export const NTEE_MAJOR_CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/** Descriptions are kept for keyword classification only, capped to bound snapshot size. */
export const MAX_DESCRIPTION_CHARS = 600;

/** The subset of a search listing the catalogue keeps. No logos or image URLs. */
export interface HarvestedOrg {
  id: string;
  ein: string | null;
  name: string;
  description: string | null;
  nteeCode: string | null;
  country: string | null;
  state: string | null;
  isCompliant: boolean;
  claimed: boolean;
  donationsReceived: number;
  /** The org's chain 1 CREATE2 address as reported by the API (advisory). */
  mainnetAddress: string | null;
}

export interface PartitionState {
  offset: number;
  done: boolean;
}

export interface HarvestState {
  /** `asOf` of the counts endpoint when the crawl started. */
  asOf: string | null;
  expected: Record<string, number>;
  partitions: Record<string, PartitionState>;
}

export interface HarvestOptions {
  client: EndaomentClient;
  dir: string;
  partitions?: string[];
  /** Stop each partition after this many orgs (partial crawls for review). */
  maxPerPartition?: number;
  /** Minimum delay between requests. Endaoment bans an IP for ~10 minutes after a 429. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Client settings for a long crawl: no response cache, and retry delays in minutes so a rate
 * limit ban is waited out instead of retried into.
 */
export function crawlClient(opts: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch } = {}): EndaomentClient {
  return new EndaomentClient({ ...opts, cache: null, maxRetries: 6, retryBaseDelayMs: 60_000 });
}

export function toHarvested(o: OrgSearchListing): HarvestedOrg {
  let mainnetAddress: string | null = null;
  try {
    mainnetAddress = getMainnetDeployment(o)?.address ?? null;
  } catch {
    mainnetAddress = null;
  }
  const description = o.description?.trim() || null;
  return {
    id: o.id,
    ein: o.ein?.trim() || null,
    name: o.name,
    description: description ? description.slice(0, MAX_DESCRIPTION_CHARS) : null,
    nteeCode: o.nteeCode?.trim() || null,
    country: o.address.country?.trim() || null,
    state: o.address.state?.trim() || null,
    isCompliant: o.isCompliant,
    claimed: o.claimed,
    donationsReceived: o.donationsReceived,
    mainnetAddress,
  };
}

const statePath = (dir: string) => join(dir, "state.json");
const partitionPath = (dir: string, code: string) => join(dir, `orgs-${code}.jsonl`);

export async function readState(dir: string): Promise<HarvestState> {
  try {
    return JSON.parse(await readFile(statePath(dir), "utf8")) as HarvestState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { asOf: null, expected: {}, partitions: {} };
    throw e;
  }
}

async function writeState(dir: string, s: HarvestState): Promise<void> {
  await writeFile(statePath(dir), JSON.stringify(s, null, 2));
}

/**
 * Crawls the Endaoment search one NTEE major group at a time, appending each page to
 * `orgs-<code>.jsonl` and checkpointing the offset after it. Re-running resumes; a page written
 * just before a crash may be appended twice, which `loadHarvest` deduplicates.
 */
export async function harvest(o: HarvestOptions): Promise<HarvestState> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const interval = o.minIntervalMs ?? 1_000;
  const codes = o.partitions ?? NTEE_MAJOR_CODES;
  await mkdir(o.dir, { recursive: true });

  const state = await readState(o.dir);
  if (!state.asOf) {
    const counts = await o.client.getCounts(NTEE_MAJOR_CODES);
    state.asOf = counts.asOf;
    state.expected = Object.fromEntries(counts.counts.map((c) => [c.nteeCode, c.orgCount]));
    await writeState(o.dir, state);
  }

  for (const code of codes) {
    const p = (state.partitions[code] ??= { offset: 0, done: false });
    const cap = o.maxPerPartition ?? Infinity;
    while (!p.done && p.offset < cap) {
      const page = await o.client.searchOrganizations({ nteeMajorCodes: [code], count: MAX_PAGE_SIZE, offset: p.offset });
      if (page.length) {
        await appendFile(partitionPath(o.dir, code), page.map((x) => JSON.stringify(toHarvested(x))).join("\n") + "\n");
      }
      p.offset += page.length;
      if (page.length < MAX_PAGE_SIZE) p.done = true;
      await writeState(o.dir, state);
      log(`${code}: ${p.offset}/${state.expected[code] ?? "?"}${p.done ? " done" : ""}`);
      if (!p.done) await sleep(interval);
    }
  }
  return state;
}

/** All harvested orgs, deduplicated by Endaoment id (the last copy wins). */
export async function loadHarvest(dir: string): Promise<HarvestedOrg[]> {
  const byId = new Map<string, HarvestedOrg>();
  const files = (await readdir(dir)).filter((f) => /^orgs-.+\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const org = JSON.parse(line) as HarvestedOrg;
      byId.set(org.id, org);
    }
  }
  return [...byId.values()];
}

/** Harvested vs expected per partition, to spot gaps (for example orgs without an NTEE code). */
export function coverage(state: HarvestState, orgs: HarvestedOrg[]): { code: string; expected: number; harvested: number }[] {
  const got = new Map<string, number>();
  for (const o of orgs) {
    const k = (o.nteeCode ?? "").charAt(0).toUpperCase() || "?";
    got.set(k, (got.get(k) ?? 0) + 1);
  }
  return NTEE_MAJOR_CODES.map((code) => ({ code, expected: state.expected[code] ?? 0, harvested: got.get(code) ?? 0 }));
}
