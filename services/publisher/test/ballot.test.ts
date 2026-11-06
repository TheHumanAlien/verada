import { buildReport, pickProof, type BuiltRegion } from "@verada/curator";
import { BUCKET_COUNT, bucketId, categoryMaskOf, causeIdOfOrg, curatedQuotas, drawIndex, planBallot, planRotation, regionMaskOf } from "@verada/sdk";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import {
  CatalogMismatch,
  createBallotPreparer,
  CuratedPicksUnavailable,
  type BallotReader,
  type CatalogEntrySource,
  type PickSource,
} from "../src/keeper/ballot.js";
import { createKeeper } from "../src/keeper/keeper.js";
import { collectLogs, EG, FakeChain, TG, token, ZAMA } from "./keeper-fakes.js";

const T1 = token(1);
const ROOT = `0x${"ab".repeat(32)}` as Hex;
const HUNGER_AF = bucketId(2, 0);
const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
sizes[HUNGER_AF] = 40;
const focus = { categoryMask: categoryMaskOf(["hunger"]), regionMask: regionMaskOf(["africa"]) };
const orgAt = (b: number, i: number) => `0x${b.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}` as Hex;

function reader(chain: FakeChain, over: Partial<BallotReader> = {}): BallotReader & { blockedReads: number } {
  const r = {
    blockedReads: 0,
    isPrepared: async (t: Address, e: bigint) => chain.prepared.has(`${t}:${e}`.toLowerCase()),
    poolOf: async () => ({ version: 1, poolSize: 40n }),
    pinned: async () => [] as Hex[],
    ballotSize: async () => 32,
    focusOf: async () => focus,
    bucketSizes: async () => sizes,
    catalogRoot: async () => ROOT,
    async isBlocked() {
      r.blockedReads++;
      return false;
    },
    ...over,
  };
  return r;
}

function entries(root = ROOT): CatalogEntrySource & { calls: number } {
  const src = {
    calls: 0,
    async entries(at: { bucket: number; index: number }[]) {
      src.calls++;
      if (at.length > 100) throw new Error("batch too large");
      return { root, items: at.map((e) => ({ ...e, orgId: orgAt(e.bucket, e.index), proof: [ROOT] })) };
    },
  };
  return src;
}

describe("ballot preparer", () => {
  it("prepares with exactly the governor's rotation draws and their proofs", async () => {
    const chain = new FakeChain();
    const p = createBallotPreparer({ reader: reader(chain), entries: entries() });
    const step = await p.plan(T1, 10n);
    expect(step.type).toBe("send");
    if (step.type !== "send" || step.action.kind !== "prepareBallot") throw new Error("no prepare");
    const expected = await planRotation(
      { token: T1, epoch: 10n, version: 1, bucketSizes: sizes, ...focus, pinned: [], ballotSize: 32 },
      { entryAt: async (b, i) => orgAt(b, i), isBlocked: async () => false },
    );
    expect(step.action.draws.map((d) => d.orgId)).toEqual(expected.draws.map((d) => d.orgId));
    expect(step.action.draws[0]!.orgId).toBe(orgAt(HUNGER_AF, drawIndex(T1, 10n, 1, 0, 40)));
    expect(step.action.draws.every((d) => d.proof.length === 1)).toBe(true);
  });

  it("opens ballots that need no draws with openEpoch, since nobody can vote before the epoch is opened", async () => {
    const chain = new FakeChain();
    const open = { type: "send", action: { kind: "openEpoch", token: T1, epoch: 10n } };
    const pins = Array.from({ length: 2 }, (_, i) => causeIdOfOrg(orgAt(HUNGER_AF, i)));
    const src = entries();
    const full = createBallotPreparer({ reader: reader(chain, { pinned: async () => pins, ballotSize: async () => 2 }), entries: src });
    expect(await full.plan(T1, 10n)).toEqual(open);
    const noPool = createBallotPreparer({ reader: reader(chain, { poolOf: async () => ({ version: 0, poolSize: 0n }) }), entries: src });
    expect(await noPool.plan(T1, 10n)).toEqual(open);
    expect(src.calls).toBe(0);
    chain.prepared.add(`${T1}:10`.toLowerCase());
    expect(await createBallotPreparer({ reader: reader(chain), entries: entries() }).plan(T1, 10n)).toMatchObject({ type: "none", reason: "ballot prepared" });
  });

  it("is run by the keeper, which sends openEpoch once for a pin-filled ballot", async () => {
    const chain = new FakeChain().register(T1);
    const pins = Array.from({ length: 2 }, (_, i) => causeIdOfOrg(orgAt(HUNGER_AF, i)));
    const keeper = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      ballots: createBallotPreparer({ reader: reader(chain, { pinned: async () => pins, ballotSize: async () => 2 }), entries: entries() }),
      tokens: async () => [T1],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 10,
      lookbackEpochs: 0,
      log: collectLogs().log,
      backoff: new Backoff(),
    });
    await keeper.run();
    expect(chain.sent).toEqual([{ kind: "openEpoch", token: T1, epoch: 10n }]);
    expect(chain.epochOf(T1, 10n).opened).toBe(true);
    await keeper.run();
    expect(chain.sent).toHaveLength(1);
  });

  it("refuses an indexer catalogue with another root, or a pool the governor disagrees with", async () => {
    const chain = new FakeChain();
    await expect(createBallotPreparer({ reader: reader(chain), entries: entries(`0x${"cd".repeat(32)}`) }).plan(T1, 10n)).rejects.toBeInstanceOf(CatalogMismatch);
    await expect(
      createBallotPreparer({ reader: reader(chain, { poolOf: async () => ({ version: 1, poolSize: 41n }) }), entries: entries() }).plan(T1, 10n),
    ).rejects.toThrow(/pool size/);
  });

  it("is run by the keeper for the current epoch, once", async () => {
    const chain = new FakeChain().register(T1);
    const { log, logs } = collectLogs();
    const src = entries();
    const keeper = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      ballots: createBallotPreparer({ reader: reader(chain), entries: src }),
      tokens: async () => [T1],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 10,
      lookbackEpochs: 0,
      log,
      backoff: new Backoff(),
    });
    const s1 = await keeper.run();
    expect(s1.ballotsChecked).toBe(1);
    expect(chain.sent.filter((a) => a.kind === "prepareBallot")).toHaveLength(1);
    expect(src.calls).toBe(1);
    const s2 = await keeper.run();
    expect(s2.ballotsChecked).toBe(0);
    expect(chain.sent.filter((a) => a.kind === "prepareBallot")).toHaveLength(1);
    expect(logs.some((l) => l.msg === "keeper tx mined")).toBe(true);
  });
});

describe("curated ballots", () => {
  const HUNGER_AS = bucketId(2, 1);
  const cSizes = Array.from({ length: BUCKET_COUNT }, () => 0);
  cSizes[HUNGER_AF] = 40;
  cSizes[HUNGER_AS] = 10;
  const cFocus = { categoryMask: categoryMaskOf(["hunger"]), regionMask: regionMaskOf(["africa", "asia"]) };
  const WRONG = `0x${"ee".repeat(32)}` as Hex;
  const pick = (orgId: Hex, catalogIndex: number) => ({ orgId, catalogIndex, name: "org", score: 50, reasons: "relevant", sources: [] });
  // Africa: 5 picks, rank 2 claims the wrong org for its index. Asia: rank 0 points past the bucket.
  const af = [pick(orgAt(HUNGER_AF, 7), 7), pick(orgAt(HUNGER_AF, 3), 3), pick(WRONG, 9), pick(orgAt(HUNGER_AF, 11), 11), pick(orgAt(HUNGER_AF, 0), 0)];
  const as = [pick(orgAt(HUNGER_AS, 99), 99), pick(orgAt(HUNGER_AS, 2), 2), pick(orgAt(HUNGER_AS, 4), 4)];
  const built = buildReport(
    {
      schema: "verada.curation/v1",
      category: "hunger",
      epoch: 10,
      catalogVersion: 1,
      generatedAt: "2026-11-09T08:00:00.000Z",
      title: "t",
      intro: "",
      regions: [
        { region: "africa", weight: 7000, summary: "", events: [], picks: af, newsletter: "" },
        { region: "asia", weight: 3000, summary: "", events: [], picks: as, newsletter: "" },
      ],
    },
    null,
  );
  const [bAf, bAs] = built.regions as [BuiltRegion, BuiltRegion];
  const onChain = [
    { bucket: HUNGER_AF, picksRoot: bAf.picksRoot, count: 5, weight: 7000 },
    { bucket: HUNGER_AS, picksRoot: bAs.picksRoot, count: 3, weight: 3000 },
  ];
  const picksFor = (region: BuiltRegion, list: ReturnType<typeof pick>[]) => ({
    picksRoot: region.picksRoot,
    items: list.map((p, rank) => ({ rank, catalogIndex: p.catalogIndex, orgId: p.orgId, proof: pickProof(region, rank, p.catalogIndex, p.orgId) })),
  });
  function picks(over: Partial<Record<string, ReturnType<typeof picksFor> | null>> = {}): PickSource & { asked: string[] } {
    const all: Record<string, ReturnType<typeof picksFor> | null> = { africa: picksFor(bAf, af), asia: picksFor(bAs, as), ...over };
    const src = {
      asked: [] as string[],
      async picks(label: string, epoch: bigint, region: string) {
        src.asked.push(`${label}/${epoch}/${region}`);
        return all[region] ?? null;
      },
    };
    return src;
  }
  const cReader = (chain: FakeChain, over: Partial<BallotReader> = {}) =>
    reader(chain, {
      poolOf: async () => ({ version: 1, poolSize: 50n }),
      ballotSize: async () => 6,
      focusOf: async () => cFocus,
      bucketSizes: async () => cSizes,
      curationsFor: async () => onChain,
      ...over,
    });

  it("draws every curated slot with pick and catalogue proofs, then rotation, exactly as the governor plans", async () => {
    const chain = new FakeChain();
    const src = picks();
    const step = await createBallotPreparer({ reader: cReader(chain), entries: entries(), picks: src }).plan(T1, 10n);
    if (step.type !== "send" || step.action.kind !== "prepareCuratedBallot") throw new Error(`expected a curated prepare, got ${JSON.stringify(step)}`);
    expect(src.asked).toEqual(["hunger/10/africa", "hunger/10/asia"]);
    // Quotas for 6 slots at 7000/3000: Africa 5 (4 + the leftover), Asia 1.
    expect(curatedQuotas(6, onChain)).toEqual([5, 1]);
    const { curated, draws } = step.action;
    expect(curated.map((c) => c.pickOrgId)).toEqual([...af.map((p) => p.orgId), as[0]!.orgId]);
    for (const [i, c] of curated.entries()) {
      const region = i < 5 ? bAf : bAs;
      const rank = i < 5 ? i : 0;
      expect(c.pickProof).toEqual(pickProof(region, rank, c.catalogIndex, c.pickOrgId));
    }
    // The mismatched pick carries the real entry, so the governor can prove the mismatch.
    expect(curated[2]).toMatchObject({ catalogIndex: 9, pickOrgId: WRONG, entryOrgId: orgAt(HUNGER_AF, 9), entryProof: [ROOT] });
    // Past the bucket's end: no entry is needed.
    expect(curated[5]).toMatchObject({ catalogIndex: 99, entryOrgId: `0x${"0".repeat(64)}`, entryProof: [] });

    const expected = await planBallot(
      { token: T1, epoch: 10n, version: 1, bucketSizes: cSizes, ...cFocus, pinned: [], ballotSize: 6, curations: onChain },
      {
        entryAt: async (b, i) => orgAt(b, i),
        pickAt: async (b, rank) => (b === HUNGER_AF ? af[rank]! : as[rank]!),
        isBlocked: async () => false,
      },
    );
    expect(expected.options).toHaveLength(6);
    expect(draws.map((d) => d.orgId)).toEqual(expected.draws.map((d) => d.orgId));
    expect(draws.length).toBeGreaterThan(0);
  });

  it("falls back to plain rotation when no agent curated the focus this epoch", async () => {
    const chain = new FakeChain();
    const src = picks();
    const step = await createBallotPreparer({ reader: cReader(chain, { curationsFor: async () => [] }), entries: entries(), picks: src }).plan(T1, 10n);
    expect(step).toMatchObject({ type: "send", action: { kind: "prepareBallot" } });
    expect(src.asked).toHaveLength(0);
    // A zeroed curation (paused agent, other version) is the same as none.
    const zeroed = await createBallotPreparer({
      reader: cReader(chain, { curationsFor: async () => onChain.map((c) => ({ ...c, count: 0, weight: 0 })) }),
      entries: entries(),
      picks: src,
    }).plan(T1, 10n);
    expect(zeroed).toMatchObject({ type: "send", action: { kind: "prepareBallot" } });
  });

  it("refuses to prepare without the agent's published picks, or with picks for another root", async () => {
    const chain = new FakeChain();
    const plan = (src?: PickSource) => createBallotPreparer({ reader: cReader(chain), entries: entries(), picks: src }).plan(T1, 10n);
    await expect(plan(picks({ asia: null }))).rejects.toBeInstanceOf(CuratedPicksUnavailable);
    await expect(plan(picks({ africa: { ...picksFor(bAf, af), picksRoot: WRONG } }))).rejects.toThrow(/not published with root/);
    await expect(plan(picks({ africa: { ...picksFor(bAf, af), items: picksFor(bAf, af).items.slice(0, 3) } }))).rejects.toThrow(/rank 3/);
    await expect(plan(undefined)).rejects.toBeInstanceOf(CuratedPicksUnavailable);
  });

  it("prepares with rotation only once the governor's curation grace has passed", async () => {
    const chain = new FakeChain();
    const plan = (required: boolean) =>
      createBallotPreparer({ reader: cReader(chain, { curationRequired: async () => required }), entries: entries(), picks: picks({ asia: null }) }).plan(T1, 10n);
    await expect(plan(true)).rejects.toBeInstanceOf(CuratedPicksUnavailable);
    const withEnd = createBallotPreparer({
      reader: cReader(chain, { curationRequired: async () => true, curationGraceEnd: async () => 1_000n }),
      entries: entries(),
      picks: picks({ asia: null }),
    });
    await expect(withEnd.plan(T1, 10n)).rejects.toMatchObject({ retryAt: 1_030_000 });
    const step = await plan(false);
    if (step.type !== "send" || step.action.kind !== "prepareBallot") throw new Error("expected a rotation prepare");
    const expected = await planRotation(
      { token: T1, epoch: 10n, version: 1, bucketSizes: cSizes, ...cFocus, pinned: [], ballotSize: 6 },
      { entryAt: async (b, i) => orgAt(b, i), isBlocked: async () => false },
    );
    expect(step.action.draws.map((d) => d.orgId)).toEqual(expected.draws.map((d) => d.orgId));
  });

  it("is sent by the keeper as prepareCuratedBallot", async () => {
    const chain = new FakeChain().register(T1);
    const keeper = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      ballots: createBallotPreparer({ reader: cReader(chain), entries: entries(), picks: picks() }),
      tokens: async () => [T1],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 10,
      lookbackEpochs: 0,
      log: collectLogs().log,
      backoff: new Backoff(),
    });
    await keeper.run();
    expect(chain.sent.map((a) => a.kind)).toEqual(["prepareCuratedBallot"]);
  });
});

describe("backoff cap", () => {
  it("never waits past a failure's retryAt", () => {
    let now = 0;
    const b = new Backoff({ baseMs: 1_000, maxMs: 100_000, now: () => now });
    for (let i = 0; i < 6; i++) b.fail("k");
    expect(b.fail("k", 5_000)).toBe(5_000);
    now = 4_999;
    expect(b.blocked("k")).toBe(true);
    now = 5_000;
    expect(b.blocked("k")).toBe(false);
    expect(b.fail("k", 1_000)).toBe(0);
  });
});
