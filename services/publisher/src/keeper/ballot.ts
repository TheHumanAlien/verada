import { DRAW_FACTOR, drawIndex, locate, planRotation, poolSize as poolSizeOf } from "@verada/sdk";
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
const none = (reason: string, terminal = false): Step => ({ type: "none", reason, terminal });

/**
 * Plans `prepareBallot` for the current epoch of a token. Only acts when rotation draws are needed:
 * an epoch whose pins fill the ballot (or that has no pool) opens on its first ballot without help.
 * The draws are computed locally (`planRotation`, mirroring the governor); the indexer supplies the
 * entries and proofs, and its catalogue must have the on-chain root of the epoch's version.
 */
export function createBallotPreparer(deps: { reader: BallotReader; entries: CatalogEntrySource }) {
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
      if (version === 0 || poolSize === 0n) return none("no catalogue pool; opens on the first ballot", true);
      const pinned: Hex[] = [];
      for (const c of pinnedAll) if (!(await r.isBlocked(c))) pinned.push(c);
      if (pinned.length >= size) return none("pins fill the ballot; opens on the first ballot", true);

      const [bucketSizes, root] = await Promise.all([r.bucketSizes(version), r.catalogRoot(version)]);
      const total = poolSizeOf(bucketSizes, focus.categoryMask, focus.regionMask);
      if (BigInt(total) !== poolSize) throw new CatalogMismatch(`pool size ${total} does not match the governor's ${poolSize}`);

      // Every entry the rotation could consume, fetched up front in batches.
      const slots = size - pinned.length;
      const sequential = total <= slots;
      const budget = sequential ? total : DRAW_FACTOR * slots;
      const wanted = new Map<string, { bucket: number; index: number }>();
      for (let k = 0; k < budget; k++) {
        const idx = sequential ? k : drawIndex(token, epoch, version, k, total);
        const at = locate(bucketSizes, focus.categoryMask, focus.regionMask, idx);
        wanted.set(`${at.bucket}:${at.index}`, at);
      }
      const got = new Map<string, EntryWithProof>();
      const list = [...wanted.values()];
      for (let i = 0; i < list.length; i += BATCH) {
        const res = await deps.entries.entries(list.slice(i, i + BATCH));
        if (res.root.toLowerCase() !== root.toLowerCase()) {
          throw new CatalogMismatch(`indexer catalogue root ${res.root} is not version ${version}'s ${root}`);
        }
        for (const e of res.items) got.set(`${e.bucket}:${e.index}`, e);
      }

      const blocked = new Map<string, boolean>();
      const plan = await planRotation(
        { token, epoch, version, bucketSizes, categoryMask: focus.categoryMask, regionMask: focus.regionMask, pinned, ballotSize: size },
        {
          async entryAt(bucket, index) {
            const e = got.get(`${bucket}:${index}`);
            if (!e) throw new CatalogMismatch(`indexer has no catalogue entry ${bucket}:${index}`);
            return e.orgId;
          },
          async isBlocked(causeId) {
            const k = causeId.toLowerCase();
            if (!blocked.has(k)) blocked.set(k, await r.isBlocked(causeId));
            return blocked.get(k)!;
          },
        },
      );
      const draws = plan.draws.map((d) => ({ orgId: d.orgId, proof: got.get(`${d.bucket}:${d.index}`)!.proof }));
      return { type: "send", action: { kind: "prepareBallot", token, epoch, draws } };
    },
  };
}

export type BallotPreparer = ReturnType<typeof createBallotPreparer>;
