import { encodeAbiParameters, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { redact, type EpochView, type ProposalView } from "../src/keeper/chain.js";
import { checkDecryption, createFakeDecryptor, decodeCleartexts, encodeCleartexts } from "../src/keeper/decrypt.js";
import { createKeeper, type KeeperDeps } from "../src/keeper/keeper.js";
import { finalizeNeedsOptions, planEpoch, planProposal } from "../src/keeper/plan.js";
import { createTokenSource } from "../src/keeper/tokens.js";
import { collectLogs, EG, FakeChain, OTHER_SCHEME, PROOF, TG, token, ZAMA } from "./keeper-fakes.js";

const T1 = token(1);
const T2 = token(2);
const T3 = token(3);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function setup(chain: FakeChain, opts: Omit<Partial<KeeperDeps>, "tokens"> & { tokens?: Address[] } = {}) {
  const { tokens: tokenList, ...over } = opts;
  const { logs, log } = collectLogs();
  let now = 1_000_000;
  const backoff = new Backoff({ baseMs: 60_000, maxMs: 600_000, now: () => now });
  const fake = chain.decryptor();
  const decryptor = over.decryptor ?? fake;
  const tokens = tokenList ?? [T1];
  const keeper = createKeeper({
    reader: chain.reader(),
    writer: chain.writer(),
    decryptor,
    tokens: async () => tokens,
    epochGovernor: EG,
    takeoverGovernor: TG,
    zamaScheme: ZAMA,
    dryRun: false,
    maxTxPerRun: 10,
    lookbackEpochs: 4,
    log,
    backoff,
    ...over,
  });
  return { keeper, logs, decryptor: fake, backoff, advance: (ms: number) => (now += ms) };
}

const kinds = (c: FakeChain) => c.sent.map((a) => a.kind);

describe("planEpoch", () => {
  const ctx = { epochGovernor: EG, zamaScheme: ZAMA };
  const v = (o: Partial<EpochView> = {}): EpochView => ({ opened: true, closed: false, finalized: false, voterCount: 3n, scheme: ZAMA, ...o });
  it("covers every branch", () => {
    expect(planEpoch(T1, 1n, v({ finalized: true }), undefined, ctx)).toEqual({ type: "none", reason: "finalized", terminal: true });
    expect(planEpoch(T1, 1n, v({ opened: false, voterCount: 0n, scheme: ZERO }), undefined, ctx)).toMatchObject({ type: "send", action: { kind: "finalizeEpoch" } });
    expect(planEpoch(T1, 1n, v({ voterCount: 0n }), undefined, ctx)).toMatchObject({ type: "send", action: { kind: "finalizeEpoch" } });
    expect(planEpoch(T1, 1n, v(), undefined, ctx)).toEqual({ type: "send", action: { kind: "closeEpoch", token: T1, epoch: 1n } });
    expect(planEpoch(T1, 1n, v({ closed: true }), { isFinal: false, counts: [] }, ctx)).toEqual({ type: "decrypt", scheme: ZAMA, governor: EG, token: T1, scope: 1n });
    expect(planEpoch(T1, 1n, v({ closed: true }), { isFinal: true, counts: [1n, 2n] }, ctx)).toMatchObject({ type: "send", action: { kind: "finalizeEpoch", orgIds: [] } });
    expect(finalizeNeedsOptions(v({ closed: true }))).toBe(true);
    expect(finalizeNeedsOptions(v({ voterCount: 0n }))).toBe(false);
    expect(finalizeNeedsOptions(v({ opened: false, voterCount: 0n }))).toBe(false);
    expect(planEpoch(T1, 1n, v({ closed: true, scheme: OTHER_SCHEME }), { isFinal: false, counts: [] }, ctx)).toMatchObject({ type: "none", terminal: false });
  });
});

describe("planProposal", () => {
  const ctx = { takeoverGovernor: TG, zamaScheme: ZAMA };
  const p = (o: Partial<ProposalView> = {}): ProposalView => ({ token: T1, state: "Closing", closed: false, tallied: false, scheme: ZAMA, ...o });
  it("covers every branch", () => {
    expect(planProposal(1n, p({ state: "Active" }), undefined, ctx)).toMatchObject({ type: "none", terminal: false });
    for (const state of ["Defeated", "Executed", "Canceled", "Expired"] as const) {
      expect(planProposal(1n, p({ state }), undefined, ctx)).toMatchObject({ type: "none", terminal: true });
    }
    expect(planProposal(1n, p(), undefined, ctx)).toEqual({ type: "send", action: { kind: "closeProposal", id: 1n } });
    expect(planProposal(1n, p({ closed: true }), { isFinal: false, counts: [] }, ctx)).toEqual({ type: "decrypt", scheme: ZAMA, governor: TG, token: T1, scope: 1n });
    expect(planProposal(1n, p({ closed: true }), { isFinal: true, counts: [1n, 2n] }, ctx)).toEqual({ type: "send", action: { kind: "recordTally", id: 1n } });
    expect(planProposal(1n, p({ state: "Succeeded", closed: true, tallied: true }), undefined, ctx)).toEqual({ type: "send", action: { kind: "execute", id: 1n } });
    expect(planProposal(1n, p({ closed: true, scheme: OTHER_SCHEME }), { isFinal: false, counts: [] }, ctx)).toMatchObject({ type: "none", terminal: false });
  });
});

describe("cleartexts", () => {
  it("encodes abi.encode of n uint256 words", () => {
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    expect(encodeCleartexts([1n, 2n, 0n])).toBe(`0x${word(1n)}${word(2n)}${word(0n)}`);
    expect(encodeCleartexts([5n, 7n])).toBe(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, 7n]));
    expect(encodeCleartexts([])).toBe("0x");
    expect(decodeCleartexts(encodeCleartexts([3n, 2n ** 64n - 1n]))).toEqual([3n, 2n ** 64n - 1n]);
    expect(() => decodeCleartexts("0x1234")).toThrow(/32-byte/);
  });

  const h = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;
  const result = (handles: Hex[], values: bigint[], clear: Record<string, unknown> = Object.fromEntries(handles.map((x, i) => [x, values[i]]))) => ({
    clearValues: clear,
    abiEncodedClearValues: encodeCleartexts(values),
    decryptionProof: PROOF,
  });

  it("accepts a decryption in handle order and returns the signed bytes unchanged", () => {
    const handles = [h(1), h(2), h(3)];
    const r = result(handles, [4n, 0n, 9n]);
    expect(checkDecryption(handles, r)).toEqual({ cleartexts: r.abiEncodedClearValues, values: [4n, 0n, 9n] });
    // Handle keys are matched case-insensitively.
    const upper = result(handles, [4n, 0n, 9n], Object.fromEntries(handles.map((x, i) => [x.toUpperCase().replace("0X", "0x"), [4n, 0n, 9n][i]])));
    expect(checkDecryption(handles, upper).values).toEqual([4n, 0n, 9n]);
  });

  it("rejects words out of handle order, the wrong count, words over 120 bits and an empty proof", () => {
    const handles = [h(1), h(2)];
    expect(() => checkDecryption(handles, result(handles, [7n, 1n], { [h(1)]: 1n, [h(2)]: 7n }))).toThrow(/does not match/);
    expect(() => checkDecryption(handles, result(handles, [1n]))).toThrow(/expected 2 words/);
    expect(() => checkDecryption(handles, result(handles, [2n ** 120n, 1n], {}))).toThrow(/120 bits/);
    expect(() => checkDecryption(handles, result(handles, [2n ** 120n - 1n, 1n], {}))).not.toThrow();
    expect(() => checkDecryption(handles, { ...result(handles, [1n, 2n]), decryptionProof: "0x" })).toThrow(/proof/);
  });

  it("fake decryptor answers in the requested handle order", async () => {
    const d = createFakeDecryptor(new Map([[h(1), 10n], [h(2), 20n]]));
    const r = await d.publicDecrypt([h(2), h(1)]);
    expect(decodeCleartexts(r.abiEncodedClearValues)).toEqual([20n, 10n]);
    expect(d.calls).toEqual([[h(2), h(1)]]);
  });
});

describe("keeper: epochs", () => {
  it("closes, decrypts, submits and finalizes an epoch in one run", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 2n, [5n, 8n, 1n]);
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const { keeper, logs, decryptor } = setup(c);
    const s = await keeper.run();
    expect(kinds(c)).toEqual(["closeEpoch", "submitTally", "finalizeEpoch"]);
    const submit = c.sent[1]!;
    expect(submit).toMatchObject({ kind: "submitTally", scheme: ZAMA, governor: EG, token: T1, scope: 9n, proof: PROOF });
    expect(decryptor.calls).toEqual([c.pollOf(EG, T1, 9n)!.handles]);
    expect(c.pollOf(EG, T1, 9n)!.counts).toEqual([5n, 8n, 1n]);
    expect(c.epochOf(T1, 9n).finalized).toBe(true);
    // A voted epoch is finalized with its ballot's org ids from the BallotPrepared log.
    expect(c.sent[2]).toEqual({ kind: "finalizeEpoch", token: T1, epoch: 9n, orgIds: c.ballots.get(`${T1}:9`.toLowerCase()) });
    expect(s).toMatchObject({ txs: 3, decrypted: 1, failed: 0, capped: false, halted: false });
    expect(logs.filter((l) => l.msg === "keeper tx mined").map((l) => l.data?.gasUsed)).toEqual([90_000n, 90_000n, 90_000n]);
  });

  it("backs off a voted epoch whose ballot log cannot be read, then finalizes it", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 2n, [5n, 8n, 1n]);
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    c.missingBallotLogs.add(`${T1}:9`.toLowerCase());
    const { keeper, logs, advance } = setup(c);
    await keeper.run();
    expect(kinds(c)).toEqual(["closeEpoch", "submitTally"]);
    expect(logs.find((l) => l.msg === "keeper step failed")).toMatchObject({ level: "error", data: { op: "read" } });
    c.missingBallotLogs.clear();
    advance(61_000);
    await keeper.run();
    expect(kinds(c)).toEqual(["closeEpoch", "submitTally", "finalizeEpoch"]);
    expect(c.epochOf(T1, 9n).finalized).toBe(true);
  });

  it("finalizes never-opened and ballot-less epochs to the default cause without closing them", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 8n, 0n);
    const { keeper, decryptor } = setup(c);
    await keeper.run();
    expect(c.sent).toEqual([6n, 7n, 8n, 9n].map((epoch) => ({ kind: "finalizeEpoch", token: T1, epoch, orgIds: [] })));
    expect(c.epochOf(T1, 8n).closed).toBe(false);
    expect(decryptor.calls).toEqual([]);
  });

  it("only looks at [current - lookback, current) and skips unregistered tokens", async () => {
    const c = new FakeChain().register(T1);
    c.current = 2n;
    const { keeper } = setup(c, { tokens: [T1, T2], lookbackEpochs: 4 });
    await keeper.run();
    expect(c.sent).toEqual([0n, 1n].map((epoch) => ({ kind: "finalizeEpoch", token: T1, epoch, orgIds: [] })));
  });

  it("is idempotent: a second run sends nothing and never re-reads finalized epochs", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [3n, 0n]);
    const { keeper } = setup(c);
    await keeper.run();
    const sent = c.sent.length;
    const reads = c.reads;
    const s = await keeper.run();
    expect(c.sent.length).toBe(sent);
    expect(s).toMatchObject({ txs: 0, epochsChecked: 0 });
    // currentEpoch and proposalCount only.
    expect(c.reads - reads).toBe(2);
  });

  it("backs off NoVotes reverts instead of retrying every run", async () => {
    const c = new FakeChain().register(T1);
    c.defaultCause = false;
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const { keeper, logs, backoff, advance } = setup(c);

    const s1 = await keeper.run();
    expect(c.sent).toEqual([]);
    expect(s1).toMatchObject({ failed: 1, txs: 0 });
    expect(logs.find((l) => l.msg === "keeper step failed")).toMatchObject({
      level: "warn",
      data: { token: T1, epoch: 9n, op: "finalizeEpoch", revert: "NoVotes", retryInSeconds: 60 },
    });

    const estimates = c.estimates.length;
    const s2 = await keeper.run();
    expect(s2).toMatchObject({ backedOff: 1, failed: 0 });
    expect(c.estimates.length).toBe(estimates);

    advance(61_000);
    await keeper.run();
    expect(c.estimates.length).toBe(estimates + 1);
    expect(backoff.failures(`epoch:${T1.toLowerCase()}:9`)).toBe(2);
    expect(logs.filter((l) => l.msg === "keeper step failed").at(-1)?.data?.retryInSeconds).toBe(120);

    // Once the owner sets a default cause, the next attempt goes through and clears the backoff.
    c.defaultCause = true;
    advance(121_000);
    await keeper.run();
    expect(kinds(c)).toEqual(["finalizeEpoch"]);
    expect(backoff.size).toBe(0);
  });

  it("backs off a failed decryption and submits nothing", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n]);
    c.epochOf(T1, 9n).closed = true;
    c.pollOf(EG, T1, 9n)!.closed = true;
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const decryptor = c.decryptor({ fail: () => new Error("relayer at https://relayer.example/key=abc timed out") });
    const { keeper, logs } = setup(c, { decryptor });
    const s = await keeper.run();
    expect(c.sent).toEqual([]);
    expect(s.failed).toBe(1);
    const failed = logs.find((l) => l.msg === "keeper step failed")!;
    expect(failed).toMatchObject({ level: "error", data: { op: "decrypt" } });
    expect(String(failed.data?.error)).not.toContain("relayer.example");
  });

  it("rejects a decryption whose words are out of handle order", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n]);
    c.epochOf(T1, 9n).closed = true;
    c.pollOf(EG, T1, 9n)!.closed = true;
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const swapped = {
      async publicDecrypt(handles: readonly Hex[]) {
        return { clearValues: { [handles[0]!]: 1n, [handles[1]!]: 2n }, abiEncodedClearValues: encodeCleartexts([2n, 1n]), decryptionProof: PROOF };
      },
    };
    const { keeper, logs } = setup(c, { decryptor: swapped });
    await keeper.run();
    expect(c.sent).toEqual([]);
    expect(String(logs.find((l) => l.msg === "keeper step failed")?.data?.error)).toMatch(/DecryptionMismatch/);
  });

  it("never decrypts a poll on another scheme but still finalizes once its tally is final", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n], OTHER_SCHEME);
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const { keeper, decryptor } = setup(c);
    await keeper.run();
    expect(kinds(c)).toEqual(["closeEpoch"]);
    expect(decryptor.calls).toEqual([]);
    Object.assign(c.pollOf(EG, T1, 9n)!, { isFinal: true, counts: [1n, 2n] });
    await keeper.run();
    expect(kinds(c)).toEqual(["closeEpoch", "finalizeEpoch"]);
  });
});

describe("keeper: alarms", () => {
  it("logs a rejected submitTally at error level with the decoded revert only", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n]);
    c.epochOf(T1, 9n).closed = true;
    c.pollOf(EG, T1, 9n)!.closed = true;
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    const { keeper, logs } = setup(c, { decryptor: c.decryptor({ proof: "0xbad0" }) });
    await keeper.run();
    expect(c.sent).toEqual([]);
    const errors = logs.filter((l) => l.level === "error");
    expect(errors).toEqual([
      { level: "error", msg: "keeper step failed", data: { token: T1, epoch: 9n, op: "submitTally", revert: "InvalidKMSSignatures", retryInSeconds: 60, failures: 1 } },
    ]);
  });

  it("logs an unexpected finalize revert at error level", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n]);
    c.epochOf(T1, 9n).closed = true;
    c.pollOf(EG, T1, 9n)!.closed = true;
    for (const e of [6n, 7n, 8n]) c.epochOf(T1, e).finalized = true;
    // The reader reports the tally final while the scheme never accepted one, so finalize reverts TallyNotFinal.
    const reader = c.reader();
    const { keeper, logs } = setup(c, { reader: { ...reader, tallyOf: async () => ({ isFinal: true, counts: [1n, 2n] }) } });
    await keeper.run();
    expect(logs.find((l) => l.msg === "keeper step failed")).toMatchObject({ level: "error", data: { op: "finalizeEpoch", revert: "TallyNotFinal" } });
  });
});

describe("keeper: takeovers", () => {
  it("closes, decrypts, submits, records and executes a passing proposal", async () => {
    const c = new FakeChain();
    const id = c.addProposal({ token: T1, quorum: 10n }, [3n, 12n]);
    const { keeper, decryptor } = setup(c, { tokens: [] });
    await keeper.run();
    expect(kinds(c)).toEqual(["closeProposal", "submitTally", "recordTally", "execute"]);
    expect(c.sent[1]).toMatchObject({ kind: "submitTally", governor: TG, token: T1, scope: id });
    expect(decryptor.calls).toHaveLength(1);
    expect(c.stateOf(id)).toBe("Executed");
  });

  it("records a proposal without ballots straight after closing it, with no decryption", async () => {
    const c = new FakeChain();
    const id = c.addProposal({ token: T1, quorum: 10n }, []);
    const { keeper, decryptor } = setup(c, { tokens: [] });
    await keeper.run();
    // The scheme's tally is final as soon as a ballot-less poll is closed.
    expect(kinds(c)).toEqual(["closeProposal", "recordTally"]);
    expect(decryptor.calls).toHaveLength(0);
    expect(c.stateOf(id)).toBe("Defeated");
  });

  it("records a defeated proposal, never executes it and stops reading it", async () => {
    const c = new FakeChain();
    const id = c.addProposal({ token: T1, quorum: 10n }, [3n, 5n]);
    const { keeper } = setup(c, { tokens: [] });
    await keeper.run();
    expect(kinds(c)).toEqual(["closeProposal", "submitTally", "recordTally"]);
    expect(c.stateOf(id)).toBe("Defeated");
    const s = await keeper.run();
    expect(s.proposalsChecked).toBe(0);
  });

  it("leaves active proposals alone and executes an already-tallied success", async () => {
    const c = new FakeChain();
    c.addProposal({ token: T1, ended: false });
    c.addProposal({ token: T2, closed: true, tallied: true, forWeight: 20n, againstWeight: 1n });
    const { keeper } = setup(c, { tokens: [] });
    await keeper.run();
    expect(c.sent).toEqual([{ kind: "execute", id: 2n }]);
  });
});

describe("keeper: limits and modes", () => {
  it("dry run estimates and logs but never sends or decrypts", async () => {
    const c = new FakeChain().register(T1);
    c.openEpoch(T1, 9n, 1n, [1n, 2n]);
    c.addProposal({ token: T2, closed: true }, [0n, 1n]);
    c.pollOf(TG, T2, 1n)!.closed = true;
    const { keeper, logs, decryptor } = setup(c, { dryRun: true });
    const s = await keeper.run();
    expect(c.sent).toEqual([]);
    expect(decryptor.calls).toEqual([]);
    expect(s.dryRun).toBe(true);
    const planned = logs.filter((l) => l.msg === "keeper dry run").map((l) => l.data?.tx);
    expect(planned).toEqual(["submitTally", "finalizeEpoch", "finalizeEpoch", "finalizeEpoch", "closeEpoch"]);
    expect(logs.find((l) => l.data?.tx === "closeEpoch")?.data).toMatchObject({ gasEstimate: 100_000n });
  });

  it("stops at the per-run transaction cap and resumes next run", async () => {
    const c = new FakeChain().register(T1).register(T2).register(T3);
    c.current = 1n;
    const { keeper, logs } = setup(c, { tokens: [T1, T2, T3], maxTxPerRun: 2 });
    const s1 = await keeper.run();
    expect(c.sent.map((a) => (a.kind === "finalizeEpoch" ? a.token : null))).toEqual([T1, T2]);
    expect(s1.capped).toBe(true);
    expect(logs.some((l) => l.msg === "keeper reached its per-run transaction cap")).toBe(true);
    const s2 = await keeper.run();
    expect(c.sent).toHaveLength(3);
    expect(s2.capped).toBe(false);
  });

  it("halts the run after a send failure so no further nonce is used", async () => {
    const c = new FakeChain().register(T1).register(T2);
    c.current = 1n;
    c.sendError = new Error("receipt timeout from https://rpc.example/v2/secret");
    const { keeper, logs } = setup(c, { tokens: [T1, T2] });
    const s = await keeper.run();
    expect(s.halted).toBe(true);
    expect(c.estimates).toHaveLength(1);
    expect(JSON.stringify(logs, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("rpc.example");
  });

  it("sends with the gas limit derived from the estimate (estimate * gasBufferPct / 100)", async () => {
    const c = new FakeChain().register(T1);
    c.current = 1n;
    const { keeper } = setup(c, { gasBufferPct: 99n });
    const s = await keeper.run();
    expect(s.halted).toBe(true);
    const c2 = new FakeChain().register(T1);
    c2.current = 1n;
    await setup(c2).keeper.run();
    expect(c2.sent).toHaveLength(1);
  });
});

describe("token source", () => {
  it("prefers the indexer and falls back to incremental factory log scans", async () => {
    const { logs, log } = collectLogs();
    let indexerUp = true;
    const scans: bigint[] = [];
    let head = 120n;
    const source = createTokenSource({
      indexer: {
        listTokens: async () => {
          if (!indexerUp) throw new Error("indexer https://api.example returned HTTP 503");
          return { items: [{ address: T1.toLowerCase() }] as never, rejected: 0 };
        },
      },
      factoryLogs: {
        async tokensCreated(from) {
          scans.push(from);
          return { tokens: from === 100n ? [T2] : [T3], toBlock: head };
        },
      },
      factoryDeployBlock: 100n,
      log,
    });
    expect(await source()).toEqual([T1]);
    indexerUp = false;
    expect(await source()).toEqual([T2]);
    head = 130n;
    expect(await source()).toEqual([T2, T3]);
    expect(scans).toEqual([100n, 121n]);
    indexerUp = true;
    expect(await source()).toEqual([T1, T2, T3]);
    expect(JSON.stringify(logs)).not.toContain("api.example");
  });

  it("throws without any source", async () => {
    const { log } = collectLogs();
    await expect(createTokenSource({ log })()).rejects.toThrow(/no token source/);
  });
});

describe("helpers", () => {
  it("backoff doubles up to the cap", () => {
    let now = 0;
    const b = new Backoff({ baseMs: 10, maxMs: 35, now: () => now });
    expect([b.fail("k"), b.fail("k"), b.fail("k"), b.fail("k")]).toEqual([10, 20, 35, 35]);
    expect(b.blocked("k")).toBe(true);
    now = 36;
    expect(b.blocked("k")).toBe(false);
    b.clear("k");
    expect(b.failures("k")).toBe(0);
  });

  it("redacts URLs and addresses from error messages", () => {
    expect(redact(`call to https://rpc.example/key failed for ${T1} at 0x${"ab".repeat(32)}`)).toBe(
      `call to <url> failed for <address> at 0x${"ab".repeat(32)}`,
    );
  });
});
