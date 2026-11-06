import { BURN_OWNER, createArkivRegistry } from "@verada/arkiv-registry";
import { FakeArkiv } from "@verada/arkiv-registry/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "../src/indexer-client.js";
import { createArkivExtendJob } from "../src/jobs/arkiv-extend.js";
import { createArkivMirrorJob } from "../src/jobs/arkiv-mirror.js";
import { startJobs } from "../src/jobs/runner.js";
import { createStampWatchJob, stampWarnings } from "../src/jobs/stamp-watch.js";
import { readConfig } from "../src/env.js";
import type { BallotReader } from "../src/keeper/ballot.js";
import { createTallyKeeperJob, missingKeeperEnv } from "../src/jobs/tally-keeper.js";
import type { StampStatus, SwarmClient } from "../src/swarm.js";
import { json } from "./helpers.js";
import { EG, FakeChain, KEEPER, TG, token, ZAMA } from "./keeper-fakes.js";

const tokenRow = (i: number, over: Record<string, unknown> = {}) => ({
  address: `0x${(0xfeed00 + i).toString(16).padStart(40, "0")}`,
  creator: "0x2222222222222222222222222222222222222222",
  pool: `0x${"cd".repeat(32)}`,
  hook: "0x3333333333333333333333333333333333333333",
  lpTokenId: String(i),
  feeBps: 100,
  metadataUri: `bzz://${"aa".repeat(32)}`,
  createdAt: "1730000000",
  createdBlock: String(21_000_000 + i),
  txHash: `0x${"ee".repeat(32)}`,
  feeTotals: null,
  label: `tok-${i}`,
  textRecords: { url: `https://t${i}.example` },
  ...over,
});

/** Fake indexer API: two token pages and one cause. */
function fakeIndexer(state: { tokens: Record<string, unknown>[]; causes: Record<string, unknown>[]; active?: string[] }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/status") return json({ mainnet: { id: 1, block: { number: 100, timestamp: Math.floor(Date.now() / 1000) - 20 } } });
    if (url.pathname === "/api/active-tokens") {
      if (!state.active) return json({ error: "not_found" }, 404);
      return json({ items: state.active.map((token) => ({ token, fees: true, voters: false, pins: false, launched: false })) });
    }
    if (url.pathname === "/api/tokens") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = state.tokens.slice(start, start + 2);
      const next = start + 2 < state.tokens.length ? String(start + 2) : null;
      return json({ items: page, nextCursor: next });
    }
    if (url.pathname === "/api/causes") return json({ items: state.causes, nextCursor: null });
    return json({ error: "not_found" }, 404);
  });
}

const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
const log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => logs.push({ level, msg, data });
afterEach(() => {
  logs.length = 0;
  vi.useRealTimers();
});

describe("arkiv-mirror job", () => {
  it("reconciles indexer state onto Arkiv and converges", async () => {
    const state = {
      tokens: [tokenRow(1), tokenRow(2), tokenRow(3), tokenRow(4, { label: undefined })],
      causes: [{ causeId: `0x${"01".repeat(32)}`, payout: "0x4444444444444444444444444444444444444444", active: true, addedAt: "1", deactivatedAt: null }],
    };
    const fetchMock = fakeIndexer(state);
    const fake = new FakeArkiv();
    const registry = createArkivRegistry({ chain: "rabdi", clients: fake, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const job = createArkivMirrorJob({
      indexer: createIndexerClient("https://api.verada.test", { fetch: fetchMock as typeof fetch }),
      registry,
      chainId: 1,
      intervalMs: 60_000,
      log,
    });

    await job.run();
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).search)).toContain("?limit=100&cursor=2");
    const cores = fake.ofSchema("verada.token");
    expect(cores).toHaveLength(3); // the unlabelled token is deferred
    expect(cores.every((c) => c.owner === BURN_OWNER && c.readonly)).toBe(true);
    expect(fake.ofSchema("verada.token-profile")).toHaveLength(3);
    expect(fake.ofSchema("verada.cause")).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ msg: "arkiv mirror run", data: { created: 3, causesCreated: 1, deferred: 1, failures: 0 } });

    // Nothing changed: the second run writes nothing.
    const writes = () => fake.calls.filter((c) => c.method !== "query").length;
    const before = writes();
    await job.run();
    expect(writes()).toBe(before);

    // A profile change on the indexer becomes one patch.
    state.tokens[0] = tokenRow(1, { textRecords: { url: "https://changed.example" } });
    await job.run();
    expect(writes()).toBe(before + 1);
    const patched = fake.ofSchema("verada.token-profile").find((p) => p.attrs.website?.value === "https://changed.example");
    expect(patched).toBeDefined();
  });

  it("dry run plans but writes nothing", async () => {
    const fake = new FakeArkiv();
    const registry = createArkivRegistry({ chain: "rabdi", clients: fake, dryRun: true, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const job = createArkivMirrorJob({
      indexer: createIndexerClient("https://api.verada.test", { fetch: fakeIndexer({ tokens: [tokenRow(1)], causes: [] }) as typeof fetch }),
      registry,
      chainId: 1,
      intervalMs: 60_000,
      log,
    });
    await job.run();
    expect(fake.entities.size).toBe(0);
    expect(logs.at(-1)).toMatchObject({ data: { dryRun: true, created: 1 } });
  });
});

describe("arkiv-extend job", () => {
  it("extends only entities expiring within 30 days", async () => {
    const fake = new FakeArkiv({ currentBlock: 100n });
    const seed = (expiresAt: bigint) =>
      fake.seed({ schema: "verada.cause", owner: fake.account, creator: fake.account, expiresAt, readonly: false, permissionlessExtension: true, attrs: {
        causeId: { type: "str", value: `c${expiresAt}` }, orgId: { type: "str", value: "" }, orgAddress: { type: "addr", value: fake.account }, name: { type: "str", value: "n" }, active: { type: "bool", value: true },
      } });
    const soon = seed(100n + 1_000_000n);
    const later = seed(100n + 5_000_000n);
    const registry = createArkivRegistry({ chain: "rabdi", clients: fake, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    await createArkivExtendJob({ registry, intervalMs: 1, log }).run();
    const batch = fake.calls.find((c) => c.method === "executeBatch")!.args as { extensions: { entityKey: string }[] };
    expect(batch.extensions.map((e) => e.entityKey)).toEqual([soon]);
    expect(fake.entities.get(later)!.expiresAt).toBe(5_000_100n);
  });
});

describe("stamp-watch job", () => {
  const status = (over: Partial<StampStatus> = {}): StampStatus => ({
    batchID: "b", utilization: 1, usable: true, depth: 20, amount: "1", bucketDepth: 16, batchTTL: 60 * 86_400, immutableFlag: true, utilizationRatio: 0.1, ...over,
  });
  it("warns on low TTL, high utilization or an unusable batch", () => {
    expect(stampWarnings(status())).toEqual([]);
    expect(stampWarnings(status({ batchTTL: 29 * 86_400 }))).toEqual(["TTL 29 days is under 30 days"]);
    expect(stampWarnings(status({ utilizationRatio: 0.75 }))).toEqual(["utilization 75.0% is over 70%"]);
    expect(stampWarnings(status({ usable: false }))).toEqual(["batch not usable"]);
  });
  it("logs a warning", async () => {
    const swarm: SwarmClient = { upload: vi.fn(), stamp: async () => status({ batchTTL: 86_400 }) };
    await createStampWatchJob({ swarm, intervalMs: 1, log }).run();
    expect(logs[0]).toMatchObject({ level: "warn", msg: "postage batch needs attention", data: { ttlDays: 1 } });
  });
});

describe("runner", () => {
  it("never overlaps runs of one job and survives failures", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const stop = startJobs(
      [
        {
          name: "slow",
          intervalMs: 100,
          run: async () => {
            active++;
            runs++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 250));
            active--;
            if (runs === 1) throw new Error("boom https://secret.example/key");
          },
        },
      ],
      log,
      { initialDelayMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThan(1);
    const failed = logs.find((l) => l.msg === "job slow failed");
    expect(failed?.data).toEqual({ error: "Error" });
  });

});

describe("tally-keeper job", () => {
  const keeperEnv = {
    KEEPER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    ETH_RPC_URL: "https://rpc.example/v2/key",
    EPOCH_GOVERNOR_ADDRESS: EG,
    VOTING_SCHEME_ADDRESS: ZAMA,
    TAKEOVER_GOVERNOR_ADDRESS: TG,
  };

  it("is not scheduled unless KEEPER_ENABLED=true", () => {
    expect(createTallyKeeperJob({ keeper: readConfig(keeperEnv).keeper, chainId: 1, log })).toBeNull();
    expect(logs[0]?.msg).toMatch(/KEEPER_ENABLED is not true/);
  });

  it("names the missing variables when enabled without them", () => {
    const k = readConfig({ KEEPER_ENABLED: "true", KEEPER_PRIVATE_KEY: keeperEnv.KEEPER_PRIVATE_KEY }).keeper;
    expect(missingKeeperEnv(k)).toEqual(["ETH_RPC_URL", "EPOCH_GOVERNOR_ADDRESS", "VOTING_SCHEME_ADDRESS", "TAKEOVER_GOVERNOR_ADDRESS"]);
    expect(createTallyKeeperJob({ keeper: k, chainId: 1, log })).toBeNull();
    expect(logs.at(-1)?.data).toEqual({ missing: ["ETH_RPC_URL", "EPOCH_GOVERNOR_ADDRESS", "VOTING_SCHEME_ADDRESS", "TAKEOVER_GOVERNOR_ADDRESS"] });
  });

  it("builds the real viem chain and Zama decryptor without network access", () => {
    const job = createTallyKeeperJob({ keeper: readConfig({ ...keeperEnv, KEEPER_ENABLED: "true" }).keeper, chainId: 1, log });
    expect(job?.name).toBe("tally-keeper");
    expect(job?.intervalMs).toBe(300_000);
    expect(JSON.stringify(logs)).not.toContain("rpc.example");
  });

  it("refuses chains without a Zama deployment", () => {
    expect(createTallyKeeperJob({ keeper: readConfig({ ...keeperEnv, KEEPER_ENABLED: "true" }).keeper, chainId: 8453, log })).toBeNull();
    expect(logs.at(-1)).toMatchObject({ level: "error", msg: "tally keeper not scheduled" });
  });

  it("runs the keeper over indexer tokens and logs a summary", async () => {
    const chain = new FakeChain().register(token(1));
    chain.current = 1n;
    const fetchMock = fakeIndexer({ tokens: [tokenRow(1, { address: token(1) })], causes: [] });
    const job = createTallyKeeperJob({
      keeper: readConfig({ ...keeperEnv, KEEPER_ENABLED: "true", KEEPER_MAX_TX_PER_RUN: "5" }).keeper,
      chainId: 1,
      indexer: createIndexerClient("https://api.verada.test", { fetch: fetchMock as unknown as typeof fetch }),
      chain: { reader: chain.reader(), writer: chain.writer() },
      decryptor: chain.decryptor(),
      log,
    })!;
    await job.run();
    expect(chain.sent).toEqual([{ kind: "finalizeEpoch", token: token(1), epoch: 0n, orgIds: [] }]);
    expect(logs.find((l) => l.msg === "tally keeper ready")?.data).toMatchObject({ keeper: KEEPER, dryRun: false, maxTxPerRun: 5 });
    expect(logs.at(-1)).toMatchObject({ msg: "tally keeper run", data: { tokens: 1, txs: 1 } });
  });

  it("skips idle tokens' current epochs using the indexer's active tokens", async () => {
    const chain = new FakeChain().register(token(1)).register(token(2));
    chain.current = 1n;
    const fetchMock = fakeIndexer({ tokens: [tokenRow(1, { address: token(1) }), tokenRow(2, { address: token(2) })], causes: [], active: [token(2).toLowerCase()] });
    const ballots: BallotReader = {
      isPrepared: async (t, e) => chain.prepared.has(`${t}:${e}`.toLowerCase()),
      poolOf: async () => ({ version: 0, poolSize: 0n }),
      pinned: async () => [],
      ballotSize: async () => 32,
      focusOf: async () => ({ categoryMask: 0n, regionMask: 0 }),
      bucketSizes: async () => [],
      catalogRoot: async () => `0x${"00".repeat(32)}`,
      isBlocked: async () => false,
    };
    const job = createTallyKeeperJob({
      keeper: readConfig({ ...keeperEnv, KEEPER_ENABLED: "true", KEEPER_LOOKBACK_EPOCHS: "1" }).keeper,
      chainId: 1,
      indexer: createIndexerClient("https://api.verada.test", { fetch: fetchMock as unknown as typeof fetch }),
      chain: { reader: chain.reader(), writer: chain.writer(), ballots },
      decryptor: chain.decryptor(),
      log,
    })!;
    await job.run();
    expect(chain.sent.filter((a) => a.kind === "openEpoch")).toEqual([{ kind: "openEpoch", token: token(2), epoch: 1n }]);
    expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/active-tokens"))?.[0])).toContain("sinceEpoch=0");
    expect(logs.find((l) => l.msg === "keeper skipped idle epoch")?.data).toMatchObject({ token: token(1), epoch: 1n });
    expect(logs.at(-1)).toMatchObject({ msg: "tally keeper run", data: { idleSkipped: 1 } });
  });
});
