import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import {
  BUCKET_COUNT,
  CATEGORIES,
  DRAW_FACTOR,
  REGION_SLOTS,
  causeIdOfOrg,
  drawIndex,
  locate,
  poolSize,
  type CatalogEntry,
  type CategoryDef,
} from "./catalog.js";

/**
 * Curator agents: one per cause, named `<ensLabel>.agent.<parent>`. Each week an agent publishes,
 * per region, up to `MAX_PICKS` ranked catalogue picks (a Merkle root) and an urgency weight for the
 * next epoch. `planBallot` mirrors `EpochGovernor._prepare`: pins, then the curated phase, then the
 * rotation fallback. Keep it in lockstep with the contract (cross-language fixture).
 */

export const AGENT_PARENT_LABEL = "agent" as const;
export const MAX_PICKS = 32;
export const MAX_WEIGHT = 10_000;

/** Merkle leaf value types of a pick (OpenZeppelin standard tree, one tree per bucket). */
export const PICK_LEAF_TYPES = ["uint8", "uint32", "bytes32"] as const;

/** Categories that have a curator agent, in bit order. */
export const AGENT_CATEGORIES: readonly (CategoryDef & { ensLabel: string })[] = CATEGORIES.filter(
  (c): c is CategoryDef & { ensLabel: string } => typeof c.ensLabel === "string",
).sort((a, b) => a.bit - b.bit);

export function agentByLabel(label: string): (CategoryDef & { ensLabel: string }) | null {
  return AGENT_CATEGORIES.find((c) => c.ensLabel === label.toLowerCase()) ?? null;
}

export function agentBySlug(slug: string): (CategoryDef & { ensLabel: string }) | null {
  return AGENT_CATEGORIES.find((c) => c.slug === slug) ?? null;
}

/** `<ensLabel>.agent.<parent>`, e.g. `homeless.agent.varada.eth`. */
export function agentName(ensLabel: string, parent = "varada.eth"): string {
  if (!agentByLabel(ensLabel)) throw new Error(`no agent for ${ensLabel}`);
  return `${ensLabel}.${AGENT_PARENT_LABEL}.${parent}`;
}

/** The agent label of `<label>.agent.<parent>`, or null. */
export function parseAgentName(name: string, parent = "varada.eth"): string | null {
  const suffix = `.${AGENT_PARENT_LABEL}.${parent}`.toLowerCase();
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (!n.endsWith(suffix)) return null;
  const label = n.slice(0, -suffix.length);
  return agentByLabel(label) ? label : null;
}

/** Leaf hash of a pick, as `CuratorRegistry` / `EpochGovernor` compute it. */
export function pickLeafHash(rank: number, catalogIndex: number, orgId: Hex): Hex {
  return keccak256(
    keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint32" }, { type: "bytes32" }], [rank, catalogIndex, orgId])),
  );
}

export interface CurationSlot {
  bucket: number;
  count: number;
  weight: number;
}

/**
 * Slots per curated bucket. Mirrors `EpochGovernor._quotas`: each bucket first gets
 * `min(count, floor(slots * weight / totalWeight))`, then leftover slots go one at a time to buckets
 * below their count, in ascending bucket order, round after round. Buckets with no picks or no
 * weight get nothing.
 */
export function curatedQuotas(slots: number, curations: readonly CurationSlot[]): number[] {
  const live = curations.map((c) => (c.count > 0 && c.weight > 0 ? c : { ...c, count: 0, weight: 0 }));
  const total = live.reduce((n, c) => n + c.weight, 0);
  const quotas = live.map(() => 0);
  if (slots <= 0 || total === 0) return quotas;
  let assigned = 0;
  live.forEach((c, i) => {
    quotas[i] = Math.min(c.count, Math.floor((slots * c.weight) / total));
    assigned += quotas[i]!;
  });
  let rest = slots - assigned;
  while (rest > 0) {
    let progressed = false;
    for (let i = 0; i < live.length && rest > 0; i++) {
      if (quotas[i]! < live[i]!.count) {
        quotas[i]!++;
        rest--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return quotas;
}

export interface PlanBallotInput {
  token: Address;
  epoch: bigint;
  version: number;
  bucketSizes: readonly number[];
  categoryMask: bigint;
  regionMask: number;
  /** Unblocked pins in effect for the epoch (cause ids), in order. */
  pinned: readonly Hex[];
  ballotSize: number;
  /**
   * Usable curations of the focus buckets, ascending by bucket: submitted for this epoch by an
   * active agent under the epoch's catalogue version (`CuratorRegistry.curationsFor`).
   */
  curations: readonly CurationSlot[];
}

export interface PlanBallotDeps {
  entryAt(bucket: number, index: number): Promise<Hex>;
  /** The agent's pick at `rank` of `bucket`: claimed catalogue index and org. */
  pickAt(bucket: number, rank: number): Promise<{ catalogIndex: number; orgId: Hex }>;
  isBlocked(causeId: Hex): Promise<boolean>;
}

export interface CuratedDrawPlan {
  bucket: number;
  rank: number;
  catalogIndex: number;
  pickOrgId: Hex;
  /** Org actually at `(bucket, catalogIndex)`; null when the index is past the bucket. */
  entryOrgId: Hex | null;
}

/** Pins, curated draws, then rotation draws; mirrors `EpochGovernor._prepare`. */
export async function planBallot(
  input: PlanBallotInput,
  deps: PlanBallotDeps,
): Promise<{ curated: CuratedDrawPlan[]; draws: CatalogEntry[]; options: Hex[]; poolSize: number }> {
  const size = input.ballotSize;
  const options: Hex[] = input.pinned.slice(0, size).map((c) => c.toLowerCase() as Hex);
  const curated: CuratedDrawPlan[] = [];
  const draws: CatalogEntry[] = [];
  const pool = input.version === 0 ? 0 : poolSize(input.bucketSizes, input.categoryMask, input.regionMask);
  const blocked = async (c: Hex) => deps.isBlocked(c);

  if (input.version !== 0 && options.length < size && input.curations.length > 0) {
    const quotas = curatedQuotas(size - options.length, input.curations);
    for (let i = 0; i < input.curations.length; i++) {
      const { bucket } = input.curations[i]!;
      for (let rank = 0; rank < quotas[i]!; rank++) {
        const pick = await deps.pickAt(bucket, rank);
        const inBucket = pick.catalogIndex < (input.bucketSizes[bucket] ?? 0);
        const entryOrgId = inBucket ? await deps.entryAt(bucket, pick.catalogIndex) : null;
        curated.push({ bucket, rank, catalogIndex: pick.catalogIndex, pickOrgId: pick.orgId, entryOrgId });
        if (options.length >= size) continue;
        if (!entryOrgId || entryOrgId.toLowerCase() !== pick.orgId.toLowerCase()) continue;
        const causeId = causeIdOfOrg(pick.orgId).toLowerCase() as Hex;
        if (options.includes(causeId) || (await blocked(causeId))) continue;
        options.push(causeId);
      }
    }
  }

  if (pool > 0 && options.length < size) {
    const slots = size - options.length;
    const sequential = pool <= slots;
    const budget = sequential ? pool : DRAW_FACTOR * slots;
    for (let k = 0; k < budget && options.length < size; k++) {
      const idx = sequential ? k : drawIndex(input.token, input.epoch, input.version, k, pool);
      const { bucket, index } = locate(input.bucketSizes, input.categoryMask, input.regionMask, idx);
      const orgId = await deps.entryAt(bucket, index);
      draws.push({ bucket, index, orgId });
      const causeId = causeIdOfOrg(orgId).toLowerCase() as Hex;
      if (options.includes(causeId) || (await blocked(causeId))) continue;
      options.push(causeId);
    }
  }
  return { curated, draws, options, poolSize: pool };
}

/** Bucket of an agent's category in a region. */
export function agentBucket(categoryBit: number, regionBit: number): number {
  if (regionBit < 0 || regionBit >= REGION_SLOTS) throw new RangeError("region bit out of range");
  const b = categoryBit * REGION_SLOTS + regionBit;
  if (b >= BUCKET_COUNT) throw new RangeError("category bit out of range");
  return b;
}
