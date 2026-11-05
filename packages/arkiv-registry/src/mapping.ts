import {
  ALL_CATEGORIES_MASK,
  ALL_REGIONS_MASK,
  bytes32ToSwarmReference,
  categorySlugs,
  isValidLabel,
  normalizeSwarmReference,
  regionSlugs,
  TOKEN_TEXT_KEYS,
} from "@verada/sdk";
import { zeroAddress, type Address, type Hex } from "viem";
import type { IndexerCause, IndexerToken } from "./indexer.js";
import { BURN_OWNER, SCHEMA_VERSION } from "./schemas.js";
import {
  CAUSE_OPTIONAL_FIELDS,
  PROFILE_OPTIONAL_FIELDS,
  type CauseDiff,
  type CauseValues,
  type CoreValues,
  type ProfileDiff,
  type ProfileDraft,
  type ProfileValues,
  type StoredCause,
  type StoredCore,
  type StoredProfile,
} from "./types.js";

/** Arkiv's `str` limit, in UTF-8 bytes. */
export const MAX_STR_BYTES = 128;
/** Cap on the profile description (stored as bytes; Arkiv allows 128 KiB, we keep it small). */
export const MAX_DESCRIPTION_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

/**
 * Truncates `s` to at most `maxBytes` UTF-8 bytes without splitting a code point. Lone surrogates
 * (which are not valid UTF-8 and which Arkiv rejects) are dropped.
 */
export function truncateStr(s: string, maxBytes: number = MAX_STR_BYTES): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Trimmed value when it fits a `str` whole, else undefined. Used for URLs and identifiers, where
 * a truncated value would be wrong rather than merely short.
 */
export function fitStr(s: string | null | undefined, maxBytes: number = MAX_STR_BYTES): string | undefined {
  if (s === null || s === undefined) return undefined;
  const t = s.trim();
  if (t.length === 0 || utf8Length(t) > maxBytes) return undefined;
  if (/[\ud800-\udfff]/u.test(t)) return undefined;
  return t;
}

/** 64-hex Swarm reference from a bytes32 / bzz / plain reference; undefined when unset or invalid. */
export function normalizeLogoRef(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(input)) return bytes32ToSwarmReference(input as Hex) ?? undefined;
    return normalizeSwarmReference(input);
  } catch {
    return undefined;
  }
}

function normalizeContenthash(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const h = input.toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(h) || h === "0x") return undefined;
  return fitStr(h);
}

const lower = (a: string) => a.toLowerCase();

/** `,a,b,` when the slugs fit a 128-byte column; `*` for a mask covering every defined bit. */
function slugColumn(slugs: string[], all: boolean): string {
  if (slugs.length === 0) return "";
  if (all) return "*";
  return fitStr(`,${slugs.join(",")},`) ?? "*";
}

/** Focus columns of `TokenCore`; all empty/zero without a focus. */
export function focusColumns(categoryMask: bigint | undefined, regionMask: number | undefined) {
  if (categoryMask === undefined || regionMask === undefined) {
    return { causeCategory: "", causeRegion: "", categoryMask: 0n, regionMask: 0 };
  }
  return {
    causeCategory: slugColumn(categorySlugs(categoryMask), (categoryMask & ALL_CATEGORIES_MASK) === ALL_CATEGORIES_MASK),
    causeRegion: slugColumn(regionSlugs(regionMask), (regionMask & ALL_REGIONS_MASK) === ALL_REGIONS_MASK),
    categoryMask,
    regionMask,
  };
}

/** Immutable `TokenCore` values for an indexer token row. */
export function toTokenCore(t: IndexerToken, chainId: number | bigint): CoreValues {
  return {
    token: t.address,
    chainId: BigInt(chainId),
    poolId: lower(t.pool),
    creator: t.creator,
    launchBlock: t.createdBlock,
    label: t.label && isValidLabel(t.label) ? t.label : "",
    metadataUri: fitStr(t.metadataUri) ?? "",
    logoRef: normalizeLogoRef(t.logoRef) ?? "",
    ...focusColumns(t.categoryMask, t.regionMask),
    version: SCHEMA_VERSION,
  };
}

/** Profile values for an indexer token, before the core key is known. Absent fields are omitted. */
export function toProfileDraft(t: IndexerToken, chainId: number | bigint): ProfileDraft {
  const text = t.textRecords ?? {};
  const description = text[TOKEN_TEXT_KEYS.description]?.trim();
  const draft: ProfileDraft = {
    token: t.address,
    chainId: BigInt(chainId),
    controller: t.controller ?? t.creator,
    editor: t.editor ?? zeroAddress,
    updatedAtBlock: t.updatedAtBlock ?? t.updatedBlock ?? t.createdBlock,
  };
  const optional: Partial<Record<(typeof PROFILE_OPTIONAL_FIELDS)[number], string | undefined>> = {
    website: fitStr(text[TOKEN_TEXT_KEYS.url]),
    twitter: fitStr(text[TOKEN_TEXT_KEYS.twitter]),
    telegram: fitStr(text[TOKEN_TEXT_KEYS.telegram]),
    discord: fitStr(text[TOKEN_TEXT_KEYS.discord]),
    description: description ? truncateStr(description, MAX_DESCRIPTION_BYTES) : undefined,
    logoRef: normalizeLogoRef(t.logoRef),
    contenthash: normalizeContenthash(t.contenthash),
  };
  for (const f of PROFILE_OPTIONAL_FIELDS) {
    const v = optional[f];
    if (v !== undefined && v !== "") draft[f] = v;
  }
  return draft;
}

/** Full `TokenProfile` values for an indexer token whose core entity is `coreKey`. */
export function toTokenProfile(t: IndexerToken, coreKey: Hex, chainId: number | bigint): ProfileValues {
  return { core: lower(coreKey) as Hex, ...toProfileDraft(t, chainId) };
}

/** `Cause` values for an indexer cause row. */
export function toCause(c: IndexerCause): CauseValues {
  const out: CauseValues = {
    causeId: lower(c.causeId),
    orgId: fitStr(c.orgId) ?? "",
    orgAddress: (c.orgAddress ?? c.payout)!,
    name: truncateStr((c.name ?? "").trim()),
    active: c.active,
  };
  const ein = fitStr(c.ein);
  const ntee = fitStr(c.nteeCode);
  if (ein) out.ein = ein;
  if (ntee) out.nteeCode = ntee;
  return out;
}

function same(a: unknown, b: unknown): boolean {
  const hex = /^0x[0-9a-f]*$/i;
  if (typeof a === "string" && typeof b === "string" && hex.test(a) && hex.test(b)) {
    return lower(a) === lower(b);
  }
  return a === b;
}

function diffValues<V extends object, O extends string>(
  current: V,
  desired: V,
  optional: readonly O[],
  ignore: readonly (keyof V)[] = [],
): { set: Partial<V>; unset: O[] } | null {
  const set: Partial<V> = {};
  const unset: O[] = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(desired)] as (keyof V)[]);
  for (const k of keys) {
    if (ignore.includes(k)) continue;
    const c = current[k];
    const d = desired[k];
    if (d === undefined) {
      if (c !== undefined && (optional as readonly string[]).includes(k as string)) unset.push(k as unknown as O);
      continue;
    }
    if (!same(c, d)) set[k] = d;
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  return { set, unset };
}

/**
 * Changes that turn `current` into `desired`, or null when nothing but `updatedAtBlock` differs.
 * A non-null diff always carries the desired `updatedAtBlock`.
 */
export function diffProfile(current: ProfileValues, desired: ProfileValues): ProfileDiff | null {
  const d = diffValues(current, desired, PROFILE_OPTIONAL_FIELDS, ["updatedAtBlock"]);
  if (!d) return null;
  d.set.updatedAtBlock = desired.updatedAtBlock;
  return d;
}

/** Changes that turn `current` into `desired`, or null when they match. */
export function diffCause(current: CauseValues, desired: CauseValues): CauseDiff | null {
  return diffValues(current, desired, CAUSE_OPTIONAL_FIELDS);
}

/** Core fields that are checked against the indexer (`logoRef` is the launch logo; it may move on). */
const CORE_CHECKED_FIELDS = ["token", "chainId", "poolId", "creator", "launchBlock", "label", "metadataUri"] as const;

export interface ReconcileInput {
  chainId: number | bigint;
  indexerTokens: IndexerToken[];
  /** Cores created by the platform (callers must filter on `$creator`). */
  existingCores: StoredCore[];
  existingProfiles: StoredProfile[];
  indexerCauses?: IndexerCause[];
  existingCauses?: StoredCause[];
  /** Current Arkiv block; with `renewBeforeBlocks` selects entities to extend. */
  currentBlock: bigint;
  renewBeforeBlocks: bigint;
  /**
   * Cores are immutable, so a token is not mirrored until the indexer reports a valid ENS label
   * (default true). Deferred tokens are reported in `deferred`.
   */
  requireLabel?: boolean;
}

export interface ReconcilePlan {
  /** New tokens: core and profile created in one batch, then the core burned. */
  creates: { core: CoreValues; profile: ProfileDraft }[];
  /** Tokens with a core but no profile. */
  profileCreates: ProfileValues[];
  patches: { key: Hex; token: Address; diff: ProfileDiff }[];
  /** Cores still owned by someone other than `BURN_OWNER` (e.g. a run interrupted mid-create). */
  burns: Hex[];
  /** Entities expiring within `renewBeforeBlocks`. */
  extends: Hex[];
  causeCreates: CauseValues[];
  causePatches: { key: Hex; causeId: string; diff: CauseDiff }[];
  deferred: { token: Address; reason: "no_label" }[];
  /** Cores whose immutable fields disagree with the indexer. Reported, never rewritten. */
  conflicts: { token: Address; key: Hex; fields: (keyof CoreValues)[] }[];
}

export function emptyPlan(): ReconcilePlan {
  return {
    creates: [],
    profileCreates: [],
    patches: [],
    burns: [],
    extends: [],
    causeCreates: [],
    causePatches: [],
    deferred: [],
    conflicts: [],
  };
}

/** Whether the plan has any writes in it (deferred and conflicts are informational). */
export function planHasWrites(p: ReconcilePlan): boolean {
  return (
    p.creates.length +
      p.profileCreates.length +
      p.patches.length +
      p.burns.length +
      p.extends.length +
      p.causeCreates.length +
      p.causePatches.length >
    0
  );
}

/** One entity per identity: prefers `prefer(e)`, then the lowest key (stable across runs). */
function pickOne<E extends { key: Hex }>(list: E[], prefer: (e: E) => boolean): E {
  return [...list].sort((a, b) => {
    const pa = prefer(a) ? 0 : 1;
    const pb = prefer(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return lower(a.key) < lower(b.key) ? -1 : lower(a.key) > lower(b.key) ? 1 : 0;
  })[0]!;
}

function groupBy<E>(list: E[], keyOf: (e: E) => string): Map<string, E[]> {
  const m = new Map<string, E[]>();
  for (const e of list) {
    const k = keyOf(e);
    const g = m.get(k);
    if (g) g.push(e);
    else m.set(k, [e]);
  }
  return m;
}

/**
 * Pure reconciliation of the indexer's view against what is already on Arkiv. Idempotent: running
 * the resulting writes and planning again yields an empty plan.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const plan = emptyPlan();
  const chainId = BigInt(input.chainId);
  const requireLabel = input.requireLabel ?? true;
  const renewBy = input.currentBlock + input.renewBeforeBlocks;
  const needsExtend = (e: { expiresAt: bigint }) => e.expiresAt <= renewBy;
  const burned = (e: { owner: Address }) => lower(e.owner) === lower(BURN_OWNER);

  const sameChain = <E extends { values: { chainId: bigint } }>(e: E) => e.values.chainId === chainId;
  const coresByToken = groupBy(input.existingCores.filter(sameChain), (c) => lower(c.values.token));
  const profilesByToken = groupBy(input.existingProfiles.filter(sameChain), (p) => lower(p.values.token));

  const seen = new Set<string>();
  for (const t of input.indexerTokens) {
    const id = lower(t.address);
    if (seen.has(id)) continue;
    seen.add(id);

    const desiredCore = toTokenCore(t, chainId);
    const cores = coresByToken.get(id);
    if (!cores) {
      if (requireLabel && desiredCore.label === "") {
        plan.deferred.push({ token: t.address, reason: "no_label" });
        continue;
      }
      plan.creates.push({ core: desiredCore, profile: toProfileDraft(t, chainId) });
      continue;
    }

    const core = pickOne(cores, burned);
    if (!burned(core)) plan.burns.push(core.key);
    if (needsExtend(core)) plan.extends.push(core.key);
    const fields = CORE_CHECKED_FIELDS.filter((f) => !same(core.values[f], desiredCore[f]));
    if (fields.length > 0) plan.conflicts.push({ token: t.address, key: core.key, fields: [...fields] });

    const desiredProfile = toTokenProfile(t, core.key, chainId);
    const profiles = profilesByToken.get(id);
    if (!profiles) {
      plan.profileCreates.push(desiredProfile);
      continue;
    }
    const profile = pickOne(profiles, (p) => lower(p.values.core) === lower(core.key));
    if (needsExtend(profile)) plan.extends.push(profile.key);
    const diff = diffProfile(profile.values, desiredProfile);
    if (diff) plan.patches.push({ key: profile.key, token: t.address, diff });
  }

  if (input.indexerCauses) {
    const causesById = groupBy(input.existingCauses ?? [], (c) => lower(c.values.causeId));
    const seenCause = new Set<string>();
    for (const c of input.indexerCauses) {
      const desired = toCause(c);
      if (seenCause.has(desired.causeId)) continue;
      seenCause.add(desired.causeId);
      const existing = causesById.get(desired.causeId);
      if (!existing) {
        plan.causeCreates.push(desired);
        continue;
      }
      const cause = pickOne(existing, () => true);
      if (needsExtend(cause)) plan.extends.push(cause.key);
      const diff = diffCause(cause.values, desired);
      if (diff) plan.causePatches.push({ key: cause.key, causeId: desired.causeId, diff });
    }
  }

  return plan;
}

/** Keys of all given entities expiring at or before `currentBlock + renewBeforeBlocks`. */
export function expiringKeys(
  entities: { key: Hex; expiresAt: bigint }[],
  currentBlock: bigint,
  renewBeforeBlocks: bigint,
): Hex[] {
  const by = currentBlock + renewBeforeBlocks;
  return entities.filter((e) => e.expiresAt <= by).map((e) => e.key);
}
