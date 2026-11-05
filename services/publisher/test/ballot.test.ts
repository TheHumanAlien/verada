import { BUCKET_COUNT, bucketId, categoryMaskOf, causeIdOfOrg, drawIndex, planRotation, regionMaskOf } from "@verada/sdk";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { CatalogMismatch, createBallotPreparer, type BallotReader, type CatalogEntrySource } from "../src/keeper/ballot.js";
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

  it("leaves ballots that need no draws to the first voter", async () => {
    const chain = new FakeChain();
    const pins = Array.from({ length: 2 }, (_, i) => causeIdOfOrg(orgAt(HUNGER_AF, i)));
    const full = createBallotPreparer({ reader: reader(chain, { pinned: async () => pins, ballotSize: async () => 2 }), entries: entries() });
    expect(await full.plan(T1, 10n)).toMatchObject({ type: "none", terminal: true });
    const noPool = createBallotPreparer({ reader: reader(chain, { poolOf: async () => ({ version: 0, poolSize: 0n }) }), entries: entries() });
    expect(await noPool.plan(T1, 10n)).toMatchObject({ type: "none", terminal: true });
    chain.prepared.add(`${T1}:10`.toLowerCase());
    expect(await createBallotPreparer({ reader: reader(chain), entries: entries() }).plan(T1, 10n)).toMatchObject({ type: "none", reason: "ballot prepared" });
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
