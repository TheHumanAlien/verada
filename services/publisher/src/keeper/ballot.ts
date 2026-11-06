import {
  AGENT_CATEGORIES,
  bucketParts,
  curatedQuotas,
  DRAW_FACTOR,
  drawIndex,
  focusBuckets,
  locate,
  planBallot,
  REGIONS,
  type CurationSlot,
} from "@verada/sdk";
import type { Address, Hex } from "viem";
import type { Step } from "./plan.js";

/** Chain reads ballot preparation needs (`EpochGovernor`, `CauseCatalog`, `CauseRegistry`, focus). */
export interface BallotReader {
  isPrepared(token: Address, epoch: bigint): Promise<boolean>;
  /** `EpochGovernor.poolOf`: catalogue version in effect at the epoch's start and the pool size. */
  poolOf(token: Address, epoch: bigint): Promise<{ version: number; poolSize: bigint }>;
  /** Cause ids pinned for the epoch (`shortlistFor`). */
  pinned(token: Address, epoch: bigint): Promise<readonly Hex[]>;
  ballotSize(): Promise<number>;
  focusOf(token: Address): Promise<{ categoryMask: bigint; regionMask: number }>;
  bucketSizes(version: number): Promise<readonly number[]>;
  catalogRoot(version: number): Promise<Hex>;
  isBlocked(causeId: Hex): Promise<boolean>;
  /**
   * `CuratorRegistry.curationsFor` through the governor's registry, for the given focus buckets
   * (ascending). Omitted, or answering [], when the governor has no curator registry.
   */
  curationsFor?(epoch: bigint, version: number, buckets: number[]): Promise<{ bucket: number; picksRoot: Hex; count: number; weight: number }[]>;
}

export interface PickWithProof {
  rank: number;
  catalogIndex: number;
  orgId: Hex;
  proof: Hex[];
}

/** An agent's picks with proofs for one bucket and epoch (indexer `/api/agents/:label/picks/...`). */
export interface PickSource {
  picks(label: string, epoch: bigint, region: string): Promise<{ picksRoot: Hex; items: PickWithProof[] } | null>;
}

/**
 * A usable curation whose picks the keeper cannot obtain. The governor requires a draw for every
 * curated slot, so this ballot cannot be prepared until the report is published or the agent is
 * paused (`CuratorRegistry.setActive(category, false)`), after which rotation fills the slots.
 */
export class CuratedPicksUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuratedPicksUnavailable";
  }
}

export interface EntryWithProof {
  bucket: number;
  index: number;
  orgId: Hex;
  proof: Hex[];
}

/** Catalogue entries with proofs, from the indexer's `/api/catalog/entries`. */
export interface CatalogEntrySource {
  entries(at: { bucket: number; index: number }[]): Promise<{ root: Hex; items: EntryWithProof[] }>;
}

export class CatalogMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMismatch";
  }
}

const BATCH = 100;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const none = (reason: string, terminal = false): Step => ({ type: "none", reason, terminal });

/**
 * Plans the opening of the current epoch of a token. Ballots are rejected until the epoch is
 * opened, and nothing opens it but a keeper (or any volunteer): `openEpoch` when the ballot needs
 * no draws (its pins fill it, or it has no catalogue pool), `prepareCuratedBallot` when curator
 * agents' picks fill some of it, `prepareBallot` with rotation draws otherwise. The plan is computed
 * locally (`planBallot`, mirroring the governor); the indexer supplies catalogue entries, pick
 * leaves and their proofs, and both must match the roots on chain.
 */
export function createBallotPreparer(deps: { reader: BallotReader; entries: CatalogEntrySource; picks?: PickSource }) {
  const r = deps.reader;
  return {
    async plan(token: Address, epoch: bigint): Promise<Step> {
      if (await r.isPrepared(token, epoch)) return none("ballot prepared", true);
      const [{ version, poolSize }, pinnedAll, size, focus] = await Promise.all([
        r.poolOf(token, epoch),
        r.pinned(token, epoch),
        r.ballotSize(),
        r.focusOf(token),
      ]);
      const open: Step = { type: "send", action: { kind: "openEpoch", token, epoch } };
      if (version === 0 || poolSize === 0n) return open;
      const pinned: Hex[] = [];
      for (const c of pinnedAll) if (!(await r.isBlocked(c))) pinned.push(c);
      if (pinned.length >= size) return open;

      const [bucketSizes, root] = await Promise.all([r.bucketSizes(version), r.catalogRoot(version)]);
      const fb = focusBuckets(bucketSizes, focus.categoryMask, focus.regionMask);
      const total = fb.reduce((n, b) => n + b.size, 0);
      if (BigInt(total) !== poolSize) throw new CatalogMismatch(`pool size ${total} does not match the governor's ${poolSize}`);
      const slots = size - pinned.length;

      // Curated phase: the agents' picks for the focus buckets, with proofs, from the indexer.
      const onChain = r.curationsFor && fb.length > 0 ? await r.curationsFor(epoch, version, fb.map((b) => b.bucket)) : [];
      const curations: (CurationSlot & { picksRoot: Hex })[] = onChain
        .filter((c) => c.count > 0 && c.weight > 0)
        .sort((a, b) => a.bucket - b.bucket);
      const quotas = curatedQuotas(slots, curations);
      const picks = new Map<string, PickWithProof>();
      for (let i = 0; i < curations.length; i++) {
        const c = curations[i]!;
        if (quotas[i] === 0) continue;
        const { categoryBit, regionBit } = bucketParts(c.bucket);
        const label = AGENT_CATEGORIES.find((a) => a.bit === categoryBit)?.ensLabel;
        const region = REGIONS.find((x) => x.bit === regionBit)?.slug;
        if (!deps.picks || !label || !region) throw new CuratedPicksUnavailable(`no pick source for bucket ${c.bucket}`);
        const got = await deps.picks.picks(label, epoch, region);
        if (!got || got.picksRoot.toLowerCase() !== c.picksRoot.toLowerCase()) {
          throw new CuratedPicksUnavailable(`${label}/${region} picks for epoch ${epoch} are not published with root ${c.picksRoot}`);
        }
        for (const p of got.items) picks.set(`${c.bucket}:${p.rank}`, p);
        for (let rank = 0; rank < quotas[i]!; rank++) {
          if (!picks.has(`${c.bucket}:${rank}`)) throw new CuratedPicksUnavailable(`${label}/${region} has no pick at rank ${rank}`);
        }
      }

      // Every entry the ballot could consume, fetched up front in batches: the curated picks'
      // entries and the rotation's draws for the most slots rotation could fill. Anything else
      // (rotation with fewer slots switches to sequential order on small pools) is fetched lazily.
      const sequential = total <= slots;
      const budget = sequential ? total : DRAW_FACTOR * slots;
      const wanted = new Map<string, { bucket: number; index: number }>();
      curations.forEach((c, i) => {
        for (let rank = 0; rank < quotas[i]!; rank++) {
          const p = picks.get(`${c.bucket}:${rank}`)!;
          if (p.catalogIndex < (bucketSizes[c.bucket] ?? 0)) wanted.set(`${c.bucket}:${p.catalogIndex}`, { bucket: c.bucket, index: p.catalogIndex });
        }
      });
      for (let k = 0; k < budget; k++) {
        const idx = sequential ? k : drawIndex(token, epoch, version, k, total);
        const at = locate(bucketSizes, focus.categoryMask, focus.regionMask, idx);
        wanted.set(`${at.bucket}:${at.index}`, at);
      }
      const got = new Map<string, EntryWithProof>();
      const fetchEntries = async (list: { bucket: number; index: number }[]) => {
        for (let i = 0; i < list.length; i += BATCH) {
          const res = await deps.entries.entries(list.slice(i, i + BATCH));
          if (res.root.toLowerCase() !== root.toLowerCase()) {
            throw new CatalogMismatch(`indexer catalogue root ${res.root} is not version ${version}'s ${root}`);
          }
          for (const e of res.items) got.set(`${e.bucket}:${e.index}`, e);
        }
      };
      await fetchEntries([...wanted.values()]);
      const entry = async (bucket: number, index: number) => {
        const key = `${bucket}:${index}`;
        if (!got.has(key)) await fetchEntries([{ bucket, index }]);
        const e = got.get(key);
        if (!e) throw new CatalogMismatch(`indexer has no catalogue entry ${key}`);
        return e;
      };

      const blocked = new Map<string, boolean>();
      const plan = await planBallot(
        { token, epoch, version, bucketSizes, categoryMask: focus.categoryMask, regionMask: focus.regionMask, pinned, ballotSize: size, curations },
        {
          entryAt: async (bucket, index) => (await entry(bucket, index)).orgId,
          async pickAt(bucket, rank) {
            const p = picks.get(`${bucket}:${rank}`);
            if (!p) throw new CuratedPicksUnavailable(`no pick at ${bucket}:${rank}`);
            return { catalogIndex: p.catalogIndex, orgId: p.orgId };
          },
          async isBlocked(causeId) {
            const k = causeId.toLowerCase();
            if (!blocked.has(k)) blocked.set(k, await r.isBlocked(causeId));
            return blocked.get(k)!;
          },
        },
      );
      const draws = plan.draws.map((d) => ({ orgId: d.orgId, proof: got.get(`${d.bucket}:${d.index}`)!.proof }));
      if (plan.curated.length === 0) return { type: "send", action: { kind: "prepareBallot", token, epoch, draws } };
      const curated = plan.curated.map((c) => {
        const pick = picks.get(`${c.bucket}:${c.rank}`)!;
        const e = c.entryOrgId ? got.get(`${c.bucket}:${c.catalogIndex}`)! : null;
        return {
          catalogIndex: c.catalogIndex,
          pickOrgId: c.pickOrgId,
          pickProof: pick.proof,
          // Past the bucket's end the governor skips the pick without reading the entry.
          entryOrgId: e ? e.orgId : ZERO32,
          entryProof: e ? e.proof : [],
        };
      });
      return { type: "send", action: { kind: "prepareCuratedBallot", token, epoch, curated, draws } };
    },
  };
}

export type BallotPreparer = ReturnType<typeof createBallotPreparer>;
