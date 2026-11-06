/**
 * Opening a token's current epoch: the planning shared by the publisher's keeper and the web app's
 * "Open this week's ballot" button. `planBallotOpening` decides, from chain state and the indexer's
 * catalogue and pick proofs, which permissionless call opens the epoch (`openEpoch`,
 * `prepareBallot` or `prepareCuratedBallot`, or `requestCurationSkip` first when a curator's picks
 * cannot be obtained) and builds its arguments; `ballotCall` turns that into
 * a contract call for any viem or wagmi writer.
 */
import { zeroAddress, type Abi, type Address, type Hex } from "viem";
import { causeCatalogAbi, causeRegistryAbi, curatorRegistryAbi, epochGovernorAbi, tokenProfileRegistryAbi } from "./abis/index.js";
import { AGENT_CATEGORIES, curatedQuotas, planBallot, type CurationSlot } from "./agents.js";
import { bucketParts, DRAW_FACTOR, drawIndex, focusBuckets, locate, REGIONS } from "./catalog.js";

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
  /**
   * `EpochGovernor.curationSkipAt`: when `prepareBallot` / `openEpoch` may skip the epoch's curated
   * phase, in seconds (0 until someone calls `requestCurationSkip`).
   */
  curationSkipAt?(token: Address, epoch: bigint): Promise<bigint>;
  /** Latest block timestamp, in seconds. */
  now?(): Promise<bigint>;
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

/**
 * A usable curation whose picks cannot be obtained. The governor requires a draw for every
 * curated slot until `CURATION_GRACE` after a `requestCurationSkip`, so the plan first sends that
 * request, then the ballot waits for the report (or for the agent to be paused); once the skip
 * applies, the ballot is prepared with rotation only.
 */
export class CuratedPicksUnavailable extends Error {
  /** When the requested skip applies (epoch ms): a rotation-only ballot is possible from then. */
  retryAt?: number;
  constructor(message: string) {
    super(message);
    this.name = "CuratedPicksUnavailable";
  }
}

export class CatalogMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMismatch";
  }
}

export type CuratedDrawArg = { catalogIndex: number; pickOrgId: Hex; pickProof: Hex[]; entryOrgId: Hex; entryProof: Hex[] };
export type DrawArg = { orgId: Hex; proof: Hex[] };

/** The permissionless call that opens a token's current epoch. */
export type BallotAction =
  | { kind: "openEpoch"; token: Address; epoch: bigint }
  | { kind: "prepareBallot"; token: Address; epoch: bigint; draws: DrawArg[] }
  | { kind: "prepareCuratedBallot"; token: Address; epoch: bigint; curated: CuratedDrawArg[]; draws: DrawArg[] }
  /** Starts the grace after which the epoch's ballot may skip curator picks nobody can obtain. */
  | { kind: "requestCurationSkip"; token: Address; epoch: bigint };

export type BallotStep = { type: "none"; reason: string; terminal: boolean } | { type: "send"; action: BallotAction };

/** `{ address, abi, functionName, args }` of a ballot action on the epoch governor. */
export function ballotCall(action: BallotAction, epochGovernor: Address): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  const base = { address: epochGovernor, abi: epochGovernorAbi as Abi };
  switch (action.kind) {
    case "openEpoch":
    case "requestCurationSkip":
      return { ...base, functionName: action.kind, args: [action.token, action.epoch] };
    case "prepareBallot":
      return { ...base, functionName: "prepareBallot", args: [action.token, action.epoch, action.draws] };
    case "prepareCuratedBallot":
      return { ...base, functionName: "prepareCuratedBallot", args: [action.token, action.epoch, action.curated, action.draws] };
  }
}

export interface BallotPreparerDeps {
  reader: BallotReader;
  entries: CatalogEntrySource;
  picks?: PickSource;
}

const BATCH = 100;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const none = (reason: string, terminal = false): BallotStep => ({ type: "none", reason, terminal });

/**
 * Plans the opening of the current epoch of a token. Ballots are rejected until the epoch is
 * opened, and anyone may open it: `openEpoch` when the ballot needs no draws (its pins fill it, or
 * it has no catalogue pool), `prepareCuratedBallot` when curator agents' picks fill some of it,
 * `prepareBallot` with rotation draws otherwise. The plan is computed locally (`planBallot`,
 * mirroring the governor); the indexer supplies catalogue entries, pick leaves and their proofs,
 * and both must match the roots on chain, so a wrong indexer can only make the plan fail.
 */
export async function planBallotOpening(deps: BallotPreparerDeps, token: Address, epoch: bigint): Promise<BallotStep> {
  const r = deps.reader;
  if (await r.isPrepared(token, epoch)) return none("ballot prepared", true);
  const [{ version, poolSize }, pinnedAll, size, focus] = await Promise.all([
    r.poolOf(token, epoch),
    r.pinned(token, epoch),
    r.ballotSize(),
    r.focusOf(token),
  ]);
  const open: BallotStep = { type: "send", action: { kind: "openEpoch", token, epoch } };
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
  let curations: (CurationSlot & { picksRoot: Hex })[] = onChain.filter((c) => c.count > 0 && c.weight > 0).sort((a, b) => a.bucket - b.bucket);
  let quotas = curatedQuotas(slots, curations);
  const picks = new Map<string, PickWithProof>();
  try {
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
  } catch (err) {
    // Missing picks: ask for the skip, which applies CURATION_GRACE later. Until then the governor
    // still takes a curated ballot from anyone holding the picks; from then, prepareBallot skips
    // the curated phase and rotation fills the ballot rather than leaving the epoch closed.
    if (!(err instanceof CuratedPicksUnavailable) || !r.curationSkipAt || !r.now) throw err;
    const skipAt = await r.curationSkipAt(token, epoch);
    if (skipAt === 0n) return { type: "send", action: { kind: "requestCurationSkip", token, epoch } };
    if ((await r.now()) < skipAt) {
      // Retry no later than the skip, when rotation becomes possible (a margin for block time).
      err.retryAt = Number(skipAt) * 1000 + 30_000;
      throw err;
    }
    curations = [];
    quotas = [];
    picks.clear();
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
}

/** {@link planBallotOpening} bound to its sources. */
export function createBallotPreparer(deps: BallotPreparerDeps) {
  return { plan: (token: Address, epoch: bigint) => planBallotOpening(deps, token, epoch) };
}

export type BallotPreparer = ReturnType<typeof createBallotPreparer>;

/**
 * The part of a viem `PublicClient` the ballot reader uses. Typed loosely so clients from any viem
 * copy in the workspace fit.
 */
export interface BallotReadClient {
  readContract(args: never): Promise<unknown>;
  getBlock(args: never): Promise<unknown>;
}

/**
 * viem-backed {@link BallotReader}. Catalogue, registry, profile registry and curator registry
 * addresses come from the governor's immutables (or its one-time setter) and are read once.
 */
export function createBallotReader(client: BallotReadClient, epochGovernor: Address): BallotReader {
  const eg = epochGovernor;
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const latest = () => client.getBlock({ blockTag: "latest" } as never) as Promise<{ timestamp: bigint }>;
  let linked: Promise<{ catalog: Address; registry: Address; profiles: Address }> | undefined;
  const links = () =>
    (linked ??= Promise.all([
      read<Address>(eg, epochGovernorAbi, "catalog"),
      read<Address>(eg, epochGovernorAbi, "registry"),
      read<Address>(eg, epochGovernorAbi, "profileRegistry"),
    ]).then(([catalog, registry, profiles]) => ({ catalog, registry, profiles })));
  let curatorsOf: Promise<Address> | undefined;
  return {
    isPrepared: (token, epoch) => read<boolean>(eg, epochGovernorAbi, "isPrepared", [token, epoch]),
    async poolOf(token, epoch) {
      const [version, poolSize] = await read<readonly [number, bigint]>(eg, epochGovernorAbi, "poolOf", [token, epoch]);
      return { version: Number(version), poolSize };
    },
    pinned: (token, epoch) => read<readonly Hex[]>(eg, epochGovernorAbi, "shortlistFor", [token, epoch]),
    ballotSize: async () => Number(await read<bigint>(eg, epochGovernorAbi, "ballotSize")),
    async focusOf(token) {
      const { profiles } = await links();
      const [categoryMask, regionMask] = await read<readonly [bigint, number]>(profiles, tokenProfileRegistryAbi, "focusOf", [token]);
      return { categoryMask, regionMask: Number(regionMask) };
    },
    async bucketSizes(version) {
      const { catalog } = await links();
      return (await read<readonly number[]>(catalog, causeCatalogAbi, "bucketSizesOf", [version])).map(Number);
    },
    async catalogRoot(version) {
      const { catalog } = await links();
      return read<Hex>(catalog, causeCatalogAbi, "rootOf", [version]);
    },
    async isBlocked(causeId) {
      const { registry } = await links();
      return read<boolean>(registry, causeRegistryAbi, "isBlocked", [causeId]);
    },
    curationSkipAt: (token, epoch) => read<bigint>(eg, epochGovernorAbi, "curationSkipAt", [token, epoch]),
    now: async () => (await latest()).timestamp,
    async curationsFor(epoch, version, buckets) {
      const curators = await (curatorsOf ??= read<Address>(eg, epochGovernorAbi, "curators"));
      if (curators === zeroAddress) return [];
      const cs = await read<readonly { picksRoot: Hex; count: number; weight: number }[]>(curators, curatorRegistryAbi, "curationsFor", [epoch, version, buckets]);
      return cs.map((c, i) => ({ bucket: buckets[i]!, picksRoot: c.picksRoot, count: Number(c.count), weight: Number(c.weight) }));
    },
  };
}
