import { createBallotPreparer } from "@verada/sdk";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { createKeeper, type ActivitySource } from "../src/keeper/keeper.js";
import { collectLogs, EG, EPOCH_ZERO, FakeChain, TG, token, WEEK, ZAMA } from "./keeper-fakes.js";

const [T1, T2, T3] = [token(1), token(2), token(3)];
const ROOT = `0x${"ab".repeat(32)}` as Hex;
/** Wall clock of the tests: one hour into epoch 10. */
const NOW_MS = Number(EPOCH_ZERO + 10n * WEEK + 3_600n) * 1000;

/** A ballot with no catalogue pool, so `openEpoch` opens it. */
const preparer = (chain: FakeChain) =>
  createBallotPreparer({
    reader: {
      isPrepared: async (t, e) => chain.prepared.has(`${t}:${e}`.toLowerCase()),
      poolOf: async () => ({ version: 0, poolSize: 0n }),
      pinned: async () => [],
      ballotSize: async () => 32,
      focusOf: async () => ({ categoryMask: 0n, regionMask: 0 }),
      bucketSizes: async () => [],
      catalogRoot: async () => ROOT,
      isBlocked: async () => false,
    },
    entries: { entries: async () => ({ root: ROOT, items: [] }) },
  });

function setup(
  opts: {
    active?: () => string[];
    activity?: ActivitySource;
    indexedAt?: () => Promise<bigint | null>;
    idleEpochs?: number;
    lookbackEpochs?: number;
    noFeeReader?: boolean;
  } = {},
) {
  const chain = new FakeChain().register(T1).register(T2).register(T3);
  const { logs, log } = collectLogs();
  const calls: [bigint, bigint][] = [];
  const activity: ActivitySource =
    opts.activity ??
    ({
      async activeTokens(e, t) {
        calls.push([e, t]);
        return (opts.active?.() ?? []).map((a) => ({ token: a.toLowerCase() }));
      },
      indexedAt: opts.indexedAt,
    } satisfies ActivitySource);
  const reader = chain.reader();
  if (opts.noFeeReader) delete reader.uncollectedFees;
  const keeper = createKeeper({
    reader,
    writer: chain.writer(),
    decryptor: chain.decryptor(),
    ballots: preparer(chain),
    tokens: async () => [T1, T2, T3],
    epochGovernor: EG,
    takeoverGovernor: TG,
    zamaScheme: ZAMA,
    dryRun: false,
    maxTxPerRun: 50,
    lookbackEpochs: opts.lookbackEpochs ?? 0,
    activity,
    idleEpochs: opts.idleEpochs,
    now: () => NOW_MS,
    log,
    backoff: new Backoff(),
  });
  return { chain, keeper, logs, calls };
}

const opened = (chain: FakeChain) => chain.sent.filter((a) => a.kind === "openEpoch").map((a) => ("token" in a ? a.token : null));

describe("idle epochs", () => {
  it("opens only active tokens' current epochs and logs each skip once", async () => {
    let active = [T1];
    const { chain, keeper, logs, calls } = setup({ active: () => active });
    const s1 = await keeper.run();
    expect(opened(chain)).toEqual([T1]);
    expect(s1).toMatchObject({ idleSkipped: 2, ballotsChecked: 1 });
    // The window is the last two epochs and the current one (current is 10).
    expect(calls[0]).toEqual([8n, EPOCH_ZERO + 8n * WEEK]);
    const skips = logs.filter((l) => l.msg === "keeper skipped idle epoch");
    expect(skips.map((l) => l.data?.token)).toEqual([T2, T3]);
    expect(skips[0]?.data).toMatchObject({ epoch: 10n, idleEpochs: 2 });

    // T2 trades (fees credited): the next run opens it; T3 stays skipped without a second log line.
    active = [T1, T2];
    const s2 = await keeper.run();
    expect(opened(chain)).toEqual([T1, T2]);
    expect(s2).toMatchObject({ idleSkipped: 1, ballotsChecked: 1 });
    expect(logs.filter((l) => l.msg === "keeper skipped idle epoch")).toHaveLength(2);

    // A new epoch: idle tokens are logged again.
    chain.current = 11n;
    await keeper.run();
    expect(logs.filter((l) => l.msg === "keeper skipped idle epoch" && l.data?.epoch === 11n)).toHaveLength(1);
  });

  it("still finalizes an idle token's ended epochs", async () => {
    const { chain, keeper } = setup({ active: () => [], lookbackEpochs: 1 });
    const s = await keeper.run();
    expect(s.idleSkipped).toBe(3);
    expect(opened(chain)).toEqual([]);
    expect(chain.sent.filter((a) => a.kind === "finalizeEpoch")).toHaveLength(3);
  });

  it("an epoch opened by a volunteer is left alone", async () => {
    const { chain, keeper } = setup({ active: () => [] });
    chain.prepared.add(`${T2}:10`.toLowerCase());
    await keeper.run();
    expect(chain.sent).toEqual([]);
  });

  it("opens every epoch when the indexer fails or the policy is off", async () => {
    const failing = setup({
      activity: {
        activeTokens: async () => {
          throw new Error("indexer /api/active-tokens returned HTTP 503 at https://indexer.example/key");
        },
      },
    });
    const s = await failing.keeper.run();
    expect(opened(failing.chain)).toEqual([T1, T2, T3]);
    expect(s.idleSkipped).toBe(0);
    const warn = failing.logs.find((l) => l.msg === "keeper could not read token activity; opening every current epoch");
    expect(warn?.level).toBe("warn");
    expect(String(warn?.data?.error)).not.toContain("indexer.example");

    const off = setup({ active: () => [], idleEpochs: 0 });
    await off.keeper.run();
    expect(opened(off.chain)).toEqual([T1, T2, T3]);
    expect(off.calls).toEqual([]);
  });

  it("clamps the window at epoch 0", async () => {
    const { chain, keeper, calls } = setup({ active: () => [T1, T2, T3], idleEpochs: 30 });
    await keeper.run();
    expect(calls[0]).toEqual([0n, EPOCH_ZERO]);
    expect(opened(chain)).toHaveLength(3);
  });

  it("opens a token whose LP position earned fees nobody collected", async () => {
    // Trading fees sit in the locked position until someone collects them, so the indexer sees no
    // fees: the keeper reads them on chain (a simulated collectFees) before skipping.
    const { chain, keeper, logs } = setup({ active: () => [] });
    chain.lpFees.set(T2.toLowerCase(), 1n);
    const s = await keeper.run();
    expect(opened(chain)).toEqual([T2]);
    expect(s.idleSkipped).toBe(2);
    expect(logs.filter((l) => l.msg === "keeper skipped idle epoch").map((l) => l.data?.token)).toEqual([T1, T3]);
  });

  it("opens the epoch when the uncollected fees cannot be read", async () => {
    const { chain, keeper, logs } = setup({ active: () => [] });
    chain.lpFeesError = new Error("execution reverted at https://rpc.example/secret-key");
    await keeper.run();
    expect(opened(chain)).toEqual([T1, T2, T3]);
    const warn = logs.find((l) => l.msg === "keeper could not read uncollected LP fees; opening the epoch");
    expect(warn?.level).toBe("warn");
    expect(String(warn?.data?.error)).not.toContain("secret-key");
  });

  it("opens every epoch when the keeper cannot see uncollected LP fees", async () => {
    const { chain, keeper, logs, calls } = setup({ active: () => [], noFeeReader: true });
    await keeper.run();
    chain.current = 11n;
    await keeper.run();
    expect(opened(chain)).toEqual([T1, T2, T3, T1, T2, T3]);
    expect(calls).toEqual([]);
    expect(logs.filter((l) => l.msg.startsWith("keeper cannot read uncollected LP fees"))).toHaveLength(1);
  });

  it("opens every epoch while the indexer is behind the chain or has indexed nothing", async () => {
    const nowS = BigInt(NOW_MS / 1000);
    const behind = setup({ active: () => [], indexedAt: async () => nowS - 601n });
    await behind.keeper.run();
    expect(opened(behind.chain)).toEqual([T1, T2, T3]);
    expect(behind.logs.find((l) => l.msg === "keeper found the indexer behind the chain; opening every current epoch")?.data).toMatchObject({
      lagSeconds: 601n,
      maxLagSeconds: 600n,
    });

    const empty = setup({ active: () => [], indexedAt: async () => null });
    await empty.keeper.run();
    expect(opened(empty.chain)).toEqual([T1, T2, T3]);

    const fresh = setup({ active: () => [T1], indexedAt: async () => nowS - 30n });
    const s = await fresh.keeper.run();
    expect(opened(fresh.chain)).toEqual([T1]);
    expect(s.idleSkipped).toBe(2);

    const failing = setup({ active: () => [], indexedAt: async () => Promise.reject(new Error("indexer /status returned HTTP 404")) });
    await failing.keeper.run();
    expect(opened(failing.chain)).toEqual([T1, T2, T3]);
  });
});
