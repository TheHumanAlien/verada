import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ballot,
  cause,
  causePoolAttribution,
  consolidationFailure,
  consolidationTotal,
  catalogVersion,
  donation,
  epoch,
  epochClock,
  epochOption,
  feeAttribution,
  feeCollection,
  feeConsolidation,
  feeTotal,
  orgDeployment,
  poll,
  profileUpdate,
  quoteAsset,
  shortlist,
  takeoverProposal,
  takeoverToken,
  takeoverVote,
  token,
  tokenFocus,
  tokenProfile,
  tokenTextRecord,
  vote,
} from "ponder:schema";
import { onCatalogVersionSet, onFocusSet } from "../src/handlers/catalog";
import { onCauseAdded, onCauseDeactivated, onPayoutUpdated } from "../src/handlers/causes";
import {
  onConsolidationFailed,
  onFeesAttributed,
  onFeesCollected,
  onFeesConsolidated,
  onSettled,
} from "../src/handlers/fees";
import {
  onBallotPrepared,
  onDonated,
  onEpochCloseFailed,
  onEpochClosed,
  onEpochFinalized,
  onEpochOpened,
  onLaunchSnapshotSet,
  onNoVoteFallbackApplied,
  onOrgDeployed,
  onShortlistScheduled,
  onShortlistSet,
  onTallyTimeoutFallbackApplied,
  onVoteCast,
} from "../src/handlers/governance";
import {
  onQuoteAssetAdded,
  onQuoteAssetDeactivated,
  onQuoteAssetReactivated,
} from "../src/handlers/quote";
import {
  onContenthashChanged,
  onControllerChanged,
  onEditorChanged,
  onLogoChanged,
  onSuppressionChanged,
  onTextChanged,
  onTokenRegistered,
} from "../src/handlers/registry";
import { onBallotCast, onPollOpened, onTallyRequested, onTallySubmitted } from "../src/handlers/scheme";
import {
  onTakeoverCanceled,
  onTakeoverClosed,
  onTakeoverExecuted,
  onTakeoverProposed,
  onTakeoverSuperseded,
  onTakeoverTallied,
  onTakeoverVoteCast,
} from "../src/handlers/takeover";
import { onTokenCreated } from "../src/handlers/token";
import * as abis from "../src/abis";
import { type ReadContract, createFakeContext } from "./fakeDb";

const T1 = "0x00000000000000000000000000000000000000a1" as const;
const T2 = "0x00000000000000000000000000000000000000a2" as const;
const WETH = "0x00000000000000000000000000000000000000b1" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const ONDO = "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c" as const;
const CAUSE = `0x${"11".repeat(32)}` as const;
const tx = { hash: `0x${"ab".repeat(32)}` as const };
const tx2 = { hash: `0x${"cd".repeat(32)}` as const };
const GOV = "0x00000000000000000000000000000000000000e1" as const;
const TAKEOVER = "0x00000000000000000000000000000000000000e2" as const;
const SCHEME = "0x00000000000000000000000000000000000000e3" as const;
const REGISTRY = "0x00000000000000000000000000000000000000e4" as const;
const WEEK = 604_800;

let h: ReturnType<typeof createFakeContext>;
const block = (n: number, ts: number) => ({ number: BigInt(n), timestamp: BigInt(ts) });
// biome-ignore lint/suspicious/noExplicitAny: test shim for event payloads
const run = (fn: any, args: object, id = "e1", b = block(1, 100), address: string = GOV, t = tx) =>
  fn({ event: { args, block: b, transaction: t, id, log: { address } }, context: h.context });

const pkMap = () =>
  new Map<object, string[]>([
      [token, ["address"]],
      [feeTotal, ["token"]],
      [feeCollection, ["id"]],
      [feeAttribution, ["id"]],
      [causePoolAttribution, ["token", "epoch", "accrualEpoch"]],
      [feeConsolidation, ["id"]],
      [consolidationFailure, ["id"]],
      [consolidationTotal, ["token", "currencyIn"]],
      [quoteAsset, ["asset"]],
      [orgDeployment, ["orgId"]],
      [cause, ["causeId"]],
      [epoch, ["token", "epoch"]],
      [donation, ["id"]],
      [vote, ["id"]],
      [tokenProfile, ["token"]],
      [tokenTextRecord, ["token", "key"]],
      [profileUpdate, ["id"]],
      [epochClock, ["id"]],
      [epochOption, ["token", "epoch", "index"]],
      [shortlist, ["token"]],
      [catalogVersion, ["version"]],
      [tokenFocus, ["token"]],
      [poll, ["governor", "token", "scope"]],
      [ballot, ["ballotRef"]],
      [takeoverProposal, ["proposalId"]],
      [takeoverVote, ["voteRef"]],
      [takeoverToken, ["token"]],
    ]);

const reset = (readContract?: ReadContract) => {
  h = createFakeContext(pkMap(), readContract);
};

beforeEach(() => reset());

describe("TokenCreated", () => {
  it("stores the token and ignores a replayed event", async () => {
    const args = {
      token: T1,
      creator: T2,
      pool: `0x${"22".repeat(32)}`,
      hook: T2,
      lpTokenId: 7n,
      feeBps: 300,
      metadataURI: "ipfs://x",
    };
    await run(onTokenCreated, args);
    await run(onTokenCreated, args);
    const rows = h.rows(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: T1, feeBps: 300, metadataUri: "ipfs://x", createdAt: 100n });
    // Reads revert in the default fake client: metadata falls back to empty strings.
    expect(rows[0]).toMatchObject({ name: "", symbol: "", label: null, suppressed: false });
  });

  it("reads name and symbol at launch and merges the earlier registration", async () => {
    const calls: string[] = [];
    reset(async ({ functionName, address }) => {
      calls.push(`${functionName}@${address}`);
      if (functionName === "name") return "Clean Water";
      if (functionName === "symbol") return "WATER";
      throw new Error("unexpected");
    });
    const logo = `0x${"77".repeat(32)}` as const;
    const labelhash = `0x${"88".repeat(32)}` as const;
    await run(onTokenRegistered, { token: T1, labelhash, label: "water", controller: T2, logoRef: logo }, "r1", block(1, 100), REGISTRY);
    await run(onLogoChanged, { token: T1, logoRef: logo }, "r2", block(1, 100), REGISTRY);
    await run(onTokenCreated, launch, "c1");
    expect(calls.sort()).toEqual([`name@${T1}`, `symbol@${T1}`]);
    expect(h.rows(token)[0]).toMatchObject({
      name: "Clean Water",
      symbol: "WATER",
      label: "water",
      labelhash,
      controller: T2,
      editor: null,
      logoRef: logo,
      contenthash: null,
      suppressed: false,
      registeredAt: 100n,
    });
    // The launch-time logo event is part of registration, not a profile update.
    expect(h.rows(profileUpdate)).toHaveLength(0);
  });
});

const launch = {
  token: T1,
  creator: T2,
  pool: `0x${"22".repeat(32)}`,
  hook: T2,
  lpTokenId: 7n,
  feeBps: 300,
  metadataURI: "ipfs://x",
};

describe("FeesCollected", () => {
  it("accumulates one USDC-denominated total per token", async () => {
    await run(onFeesCollected, { token: T1, platformAmount: 1_000_000n, causeAmount: 9_000_000n, currency: USDC }, "a");
    await run(onFeesCollected, { token: T1, platformAmount: 500_000n, causeAmount: 4_500_000n, currency: USDC }, "b", block(2, 200));
    await run(onFeesCollected, { token: T2, platformAmount: 1n, causeAmount: 9n, currency: USDC }, "c");
    expect(h.rows(feeCollection)).toHaveLength(3);
    const totals = h.rows(feeTotal);
    expect(totals).toHaveLength(2);
    expect(totals.find((r) => r.token === T1)).toMatchObject({
      settlementAsset: USDC,
      platformAmount: 1_500_000n,
      causeAmount: 13_500_000n,
      collections: 2,
      lastCollectedAt: 200n,
    });
  });
});

describe("FeesAttributed", () => {
  const part = (epoch: bigint, accrualEpoch: bigint, causeAmount: bigint) => ({
    token: T1,
    epoch,
    accrualEpoch,
    causeAmount,
  });

  it("credits each part to its epoch pool by accrual epoch and counts the deposit once", async () => {
    // Deposit 1: fees earned in epochs 3 and 4; epoch 3 is settled, so its part goes to epoch 4.
    await run(onFeesAttributed, part(4n, 3n, 2_000_000n), "d1a", block(10, 1000));
    await run(onFeesAttributed, part(4n, 4n, 6_300_000n), "d1b", block(10, 1000));
    await run(onFeesCollected, { token: T1, platformAmount: 920_000n, causeAmount: 8_300_000n, currency: USDC }, "d1", block(10, 1000));
    // Deposit 2, one part, plus another token's deposit in between.
    await run(onFeesAttributed, { ...part(1n, 1n, 9n), token: T2 }, "x1a", block(11, 1100));
    await run(onFeesCollected, { token: T2, platformAmount: 1n, causeAmount: 9n, currency: USDC }, "x1", block(11, 1100));
    await run(onFeesAttributed, part(4n, 4n, 700_000n), "d2a", block(12, 1200), GOV, tx2);
    await run(onFeesCollected, { token: T1, platformAmount: 77_000n, causeAmount: 700_000n, currency: USDC }, "d2", block(12, 1200), GOV, tx2);
    // A replayed part is not counted twice.
    await run(onFeesAttributed, part(4n, 4n, 700_000n), "d2a", block(12, 1200), GOV, tx2);

    expect(h.rows(feeTotal).find((r) => r.token === T1)).toMatchObject({
      platformAmount: 997_000n,
      causeAmount: 9_000_000n,
      collections: 2,
      lastCollectedAt: 1200n,
    });
    const collections = h.rows(feeCollection).filter((r) => r.token === T1);
    expect(collections.map((r) => [r.id, r.depositSeq, r.causeAmount])).toEqual([
      ["d1", 1, 8_300_000n],
      ["d2", 2, 700_000n],
    ]);
    const parts = h.rows(feeAttribution).filter((r) => r.token === T1);
    expect(parts.map((r) => [r.id, r.depositSeq, r.epoch, r.accrualEpoch, r.causeAmount])).toEqual([
      ["d1a", 1, 4n, 3n, 2_000_000n],
      ["d1b", 1, 4n, 4n, 6_300_000n],
      ["d2a", 2, 4n, 4n, 700_000n],
    ]);
    expect(parts[2]).toMatchObject({ timestamp: 1200n, txHash: tx2.hash });
    // The parts of each deposit sum to its FeesCollected.causeAmount.
    for (const c of collections) {
      const sum = parts.filter((p) => p.depositSeq === c.depositSeq).reduce((a, p) => a + (p.causeAmount as bigint), 0n);
      expect(sum).toBe(c.causeAmount);
    }
    expect(h.rows(causePoolAttribution).filter((r) => r.token === T1)).toEqual([
      { token: T1, epoch: 4n, accrualEpoch: 3n, causeAmount: 2_000_000n, parts: 1, firstAttributedAt: 1000n, lastAttributedAt: 1000n },
      { token: T1, epoch: 4n, accrualEpoch: 4n, causeAmount: 7_000_000n, parts: 2, firstAttributedAt: 1000n, lastAttributedAt: 1200n },
    ]);
    expect(h.rows(epoch).map((r) => [r.token, r.epoch, r.causeAttributed])).toEqual([
      [T1, 4n, 9_000_000n],
      [T2, 1n, 9n],
    ]);
  });

  it("adds to an epoch row that governance created and records its settlement", async () => {
    await run(onVoteCast, { token: T1, epoch: 4n, voteRef: `0x${"01".repeat(32)}` }, "v1");
    await run(onFeesAttributed, part(4n, 4n, 5n), "a1", block(2, 200));
    await run(onEpochFinalized, { token: T1, epoch: 4n, causeId: CAUSE }, "f", block(3, 300));
    await run(onSettled, { token: T1, epoch: 4n, currency: USDC, amount: 5n }, "s", block(4, 400));
    expect(h.rows(epoch)).toHaveLength(1);
    expect(h.rows(epoch)[0]).toMatchObject({
      voteCount: 1,
      causeAttributed: 5n,
      winningCauseId: CAUSE,
      settledAmount: 5n,
      settledAt: 400n,
    });
  });
});

describe("fee consolidation", () => {
  it("records consolidations and failures with cumulative counters", async () => {
    await run(onConsolidationFailed, { token: T1, currencyIn: ONDO, amountIn: 50n, reason: "0x1234" }, "f1", block(1, 100));
    await run(onFeesConsolidated, { token: T1, currencyIn: ONDO, amountIn: 50n, settlementOut: 7_000_000n }, "c1", block(2, 200));
    await run(onFeesConsolidated, { token: T1, currencyIn: WETH, amountIn: 3n, settlementOut: 9_000n }, "c2", block(3, 300));
    await run(onConsolidationFailed, { token: T1, currencyIn: ONDO, amountIn: 5n, reason: "0x" }, "f2", block(4, 400));
    expect(h.rows(feeConsolidation)).toHaveLength(2);
    expect(h.rows(consolidationFailure)).toHaveLength(2);
    const totals = h.rows(consolidationTotal);
    expect(totals).toHaveLength(2);
    expect(totals.find((r) => r.currencyIn === ONDO)).toMatchObject({
      consolidatedAmountIn: 50n,
      settlementOut: 7_000_000n,
      consolidations: 1,
      failedAmountIn: 55n,
      failures: 2,
      lastFailureAt: 400n,
      lastConsolidatedAt: 200n,
    });
    expect(totals.find((r) => r.currencyIn === WETH)).toMatchObject({
      consolidations: 1,
      failures: 0,
      lastFailureAt: null,
    });
  });
});

describe("quote assets", () => {
  it("adds, deactivates and reactivates; ignores unknown assets", async () => {
    await run(onQuoteAssetDeactivated, { asset: ONDO }, "x");
    expect(h.rows(quoteAsset)).toHaveLength(0);
    await run(onQuoteAssetAdded, { asset: ONDO, decimals: 18, kind: 1 }, "q1", block(1, 100));
    await run(onQuoteAssetAdded, { asset: ONDO, decimals: 18, kind: 1 }, "q1b");
    expect(h.rows(quoteAsset)).toEqual([
      { asset: ONDO, decimals: 18, kind: 1, active: true, addedAt: 100n, updatedAt: 100n },
    ]);
    await run(onQuoteAssetDeactivated, { asset: ONDO }, "q2", block(2, 200));
    expect(h.rows(quoteAsset)[0]).toMatchObject({ active: false, updatedAt: 200n });
    await run(onQuoteAssetReactivated, { asset: ONDO }, "q3", block(3, 300));
    expect(h.rows(quoteAsset)[0]).toMatchObject({ active: true, updatedAt: 300n });
  });
});

describe("org deployment", () => {
  it("stores the deployed org once", async () => {
    const orgId = `0x${"33".repeat(32)}` as const;
    await run(onOrgDeployed, { orgId, org: T2 }, "o1", block(1, 100));
    await run(onOrgDeployed, { orgId, org: T2 }, "o2", block(2, 200));
    expect(h.rows(orgDeployment)).toEqual([
      { orgId, org: T2, deployedAt: 100n, txHash: tx.hash },
    ]);
  });
});

describe("causes", () => {
  it("adds, deactivates and reactivates", async () => {
    await run(onCauseAdded, { causeId: CAUSE, payout: T1 });
    expect(h.rows(cause)[0]).toMatchObject({ active: true, deactivatedAt: null });
    await run(onCauseDeactivated, { causeId: CAUSE }, "e2", block(2, 300));
    expect(h.rows(cause)[0]).toMatchObject({ active: false, deactivatedAt: 300n });
    await run(onCauseAdded, { causeId: CAUSE, payout: T2 }, "e3");
    expect(h.rows(cause)[0]).toMatchObject({ active: true, payout: T2, deactivatedAt: null });
  });

  it("follows payout updates and ignores unknown causes", async () => {
    await run(onPayoutUpdated, { causeId: CAUSE, oldPayout: T1, newPayout: T2 });
    expect(h.rows(cause)).toHaveLength(0);
    await run(onCauseAdded, { causeId: CAUSE, payout: T1 });
    await run(onPayoutUpdated, { causeId: CAUSE, oldPayout: T1, newPayout: T2 }, "e9");
    expect(h.rows(cause)[0]).toMatchObject({ payout: T2, active: true });
  });

  it("ignores deactivation of an unknown cause", async () => {
    await run(onCauseDeactivated, { causeId: CAUSE });
    expect(h.rows(cause)).toHaveLength(0);
  });
});

describe("epochs", () => {
  it("counts votes, records the winner and the donation", async () => {
    await run(onVoteCast, { token: T1, epoch: 3n, voteRef: `0x${"01".repeat(32)}` }, "v1");
    await run(onVoteCast, { token: T1, epoch: 3n, voteRef: `0x${"02".repeat(32)}` }, "v2");
    await run(onEpochFinalized, { token: T1, epoch: 3n, causeId: CAUSE }, "f", block(5, 500));
    await run(onDonated, { token: T1, epoch: 3n, causeId: CAUSE, payout: T2, amount: 1_000_000n }, "d", block(6, 600));
    expect(h.rows(vote)).toHaveLength(2);
    expect(h.rows(donation)).toHaveLength(1);
    expect(h.rows(epoch)).toHaveLength(1);
    expect(h.rows(epoch)[0]).toMatchObject({
      voteCount: 2,
      winningCauseId: CAUSE,
      finalizedAt: 500n,
      donatedAmount: 1_000_000n,
      donatedPayout: T2,
      donatedAt: 600n,
    });
  });

  it("creates the epoch row when finalized without prior votes", async () => {
    await run(onEpochFinalized, { token: T1, epoch: 4n, causeId: CAUSE });
    expect(h.rows(epoch)[0]).toMatchObject({ epoch: 4n, voteCount: 0, winningCauseId: CAUSE });
  });
});

describe("token profile registry", () => {
  const labelhash = `0x${"88".repeat(32)}` as const;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const register = () =>
    run(onTokenRegistered, { token: T1, labelhash, label: "water", controller: T2, logoRef: `0x${"00".repeat(32)}` }, "r0", block(1, 100), REGISTRY);

  it("registers, ignores a replay, and treats a zero logo as unset", async () => {
    await register();
    await register();
    expect(h.rows(tokenProfile)).toEqual([
      {
        token: T1,
        label: "water",
        labelhash,
        controller: T2,
        editor: null,
        logoRef: null,
        contenthash: null,
        suppressed: false,
        registeredAt: 100n,
        txHash: tx.hash,
      },
    ]);
  });

  it("mirrors controller, editor, logo, contenthash and suppression onto the token row", async () => {
    await register();
    await run(onTokenCreated, launch, "c1");
    const logo = `0x${"99".repeat(32)}` as const;
    await run(onEditorChanged, { token: T1, editor: WETH }, "p1", block(2, 200), REGISTRY, tx2);
    await run(onLogoChanged, { token: T1, logoRef: logo }, "p2", block(2, 200), REGISTRY, tx2);
    await run(onContenthashChanged, { token: T1, hash: "0xe301" }, "p3", block(2, 200), REGISTRY, tx2);
    await run(onSuppressionChanged, { token: T1, suppressed: true }, "p4", block(2, 200), REGISTRY, tx2);
    expect(h.rows(token)[0]).toMatchObject({ editor: WETH, logoRef: logo, contenthash: "0xe301", suppressed: true });
    await run(onEditorChanged, { token: T1, editor: ZERO }, "p5", block(3, 300), REGISTRY, tx2);
    await run(onControllerChanged, { token: T1, previousController: T2, newController: ONDO }, "p6", block(3, 300), REGISTRY, tx2);
    await run(onContenthashChanged, { token: T1, hash: "0x" }, "p7", block(3, 300), REGISTRY, tx2);
    expect(h.rows(token)[0]).toMatchObject({ controller: ONDO, editor: null, contenthash: null });
    expect(h.rows(tokenProfile)[0]).toMatchObject({ controller: ONDO, editor: null, logoRef: logo, suppressed: true });
    expect(h.rows(profileUpdate).map((r) => r.field)).toEqual([
      "editor",
      "logo",
      "contenthash",
      "editor",
      "controller",
      "contenthash",
    ]);
    expect(h.rows(profileUpdate).find((r) => r.id === "p6")).toMatchObject({
      token: T1,
      value: ONDO,
      key: null,
      timestamp: 300n,
      txHash: tx2.hash,
    });
  });

  it("keeps the latest value per text record key", async () => {
    await register();
    await run(onTextChanged, { token: T1, indexedKey: `0x${"12".repeat(32)}`, key: "url", value: "https://a.example" }, "t1", block(2, 200), REGISTRY, tx2);
    await run(onTextChanged, { token: T1, indexedKey: `0x${"12".repeat(32)}`, key: "url", value: "https://b.example" }, "t2", block(3, 300), REGISTRY, tx2);
    await run(onTextChanged, { token: T1, indexedKey: `0x${"13".repeat(32)}`, key: "com.twitter", value: "water" }, "t3", block(3, 300), REGISTRY, tx2);
    expect(h.rows(tokenTextRecord)).toEqual([
      { token: T1, key: "url", value: "https://b.example", updatedAt: 300n, updatedBlock: 3n },
      { token: T1, key: "com.twitter", value: "water", updatedAt: 300n, updatedBlock: 3n },
    ]);
    expect(h.rows(profileUpdate).filter((r) => r.field === "text")).toHaveLength(3);
    expect(h.rows(profileUpdate)[2]).toMatchObject({ key: "com.twitter", value: "water" });
  });

  it("ignores profile changes for unknown tokens apart from the activity entry", async () => {
    await run(onControllerChanged, { token: T2, previousController: T1, newController: ONDO }, "x1", block(2, 200), REGISTRY, tx2);
    expect(h.rows(tokenProfile)).toHaveLength(0);
    expect(h.rows(token)).toHaveLength(0);
    expect(h.rows(profileUpdate)).toHaveLength(1);
  });
});

describe("epoch lifecycle", () => {
  const C2 = `0x${"22".repeat(32)}` as const;
  // Epoch 3 of a governor whose epoch 0 started at week 2900.
  const zero = 2900 * WEEK;
  const inEpoch3 = zero + 3 * WEEK + 1234;

  it("opens with frozen options, links the poll, records the clock, closes and falls back", async () => {
    await run(onPollOpened, { governor: GOV, token: T1, scope: 3n, optionCount: 2 }, "p", block(10, inEpoch3), SCHEME);
    await run(onEpochOpened, { token: T1, epoch: 3n, options: [CAUSE, C2] }, "o", block(10, inEpoch3));
    expect(h.rows(epochOption)).toEqual([
      { token: T1, epoch: 3n, index: 0, causeId: CAUSE },
      { token: T1, epoch: 3n, index: 1, causeId: C2 },
    ]);
    expect(h.rows(epoch)[0]).toMatchObject({
      opened: true,
      openedAt: BigInt(inEpoch3),
      governor: GOV,
      scheme: SCHEME,
      closed: false,
      voterCount: 0,
      fallbackApplied: false,
    });
    expect(h.rows(epochClock)).toEqual([
      { id: "epoch_governor", epochZeroStart: BigInt(zero), epochLength: BigInt(WEEK) },
    ]);
    await run(onEpochClosed, { token: T1, epoch: 3n }, "c", block(11, zero + 4 * WEEK + 5));
    await run(onNoVoteFallbackApplied, { token: T1, epoch: 3n, causeId: CAUSE }, "n", block(12, zero + 4 * WEEK + 9));
    await run(onEpochFinalized, { token: T1, epoch: 3n, causeId: CAUSE }, "f", block(12, zero + 4 * WEEK + 9));
    expect(h.rows(epoch)[0]).toMatchObject({
      closed: true,
      closedAt: BigInt(zero + 4 * WEEK + 5),
      fallbackApplied: true,
      winningCauseId: CAUSE,
    });
    expect(h.rows(epochClock)).toHaveLength(1);
  });

  it("stores the launch snapshot on the launch epoch and records the clock", async () => {
    const snapshot = BigInt(inEpoch3 + 86_400);
    await run(onLaunchSnapshotSet, { token: T1, epoch: 3n, snapshot }, "ls", block(10, inEpoch3));
    await run(onBallotPrepared, { token: T1, epoch: 3n, catalogVersion: 1, poolSize: 10n, pinned: 0, options: [CAUSE, C2] }, "bp", block(11, inEpoch3 + 90_000));
    await run(onVoteCast, { token: T1, epoch: 4n, voteRef: `0x${"01".repeat(32)}` }, "v", block(12, zero + 4 * WEEK + 1));
    expect(h.rows(epoch).map((r) => [r.epoch, r.launchSnapshot ?? null, r.prepared === true])).toEqual([
      [3n, snapshot, true],
      [4n, null, false],
    ]);
    expect(h.rows(epoch)[0]).toMatchObject({ voteCount: 0, opened: false, causeAttributed: 0n });
    expect(h.rows(epochClock)).toEqual([
      { id: "epoch_governor", epochZeroStart: BigInt(zero), epochLength: BigInt(WEEK) },
    ]);
  });

  it("derives the clock from a vote and counts voters", async () => {
    await run(onVoteCast, { token: T1, epoch: 3n, voteRef: `0x${"01".repeat(32)}` }, "v1", block(10, inEpoch3));
    await run(onVoteCast, { token: T1, epoch: 3n, voteRef: `0x${"02".repeat(32)}` }, "v2", block(10, inEpoch3 + 60));
    expect(h.rows(epoch)[0]).toMatchObject({ voteCount: 2, voterCount: 2, opened: false });
    expect(h.rows(epochClock)[0]).toMatchObject({ epochZeroStart: BigInt(zero) });
  });

  it("uses the legacy shortlist events only until a scheduled one arrives", async () => {
    await run(onShortlistSet, { token: T1, causes: [CAUSE] }, "s1", block(1, 100));
    await run(onShortlistSet, { token: T1, causes: [C2, CAUSE] }, "s2", block(2, 200));
    expect(h.rows(shortlist)).toEqual([
      { token: T1, causeIds: [C2, CAUSE], effectiveFrom: null, previousCauseIds: [], scheduled: false, updatedAt: 200n },
    ]);
    await run(onShortlistScheduled, { token: T1, effectiveFrom: 4n, causes: [C2, CAUSE] }, "s3", block(2, 200));
    await run(onShortlistSet, { token: T1, causes: [CAUSE] }, "s4", block(3, 300));
    expect(h.rows(shortlist)[0]).toMatchObject({ causeIds: [C2, CAUSE], effectiveFrom: 4n, scheduled: true });
  });

  it("schedules token shortlists like the governor, keeping the list still in effect", async () => {
    const sched = (causes: string[], effectiveFrom: bigint, id: string) =>
      run(onShortlistScheduled, { token: T1, effectiveFrom, causes }, id, block(1, 100));
    // First list with nothing in effect applies at once (current epoch 3).
    await run(onShortlistSet, { token: T1, causes: [CAUSE] }, "a0", block(1, 100));
    await sched([CAUSE], 3n, "a1");
    expect(h.rows(shortlist)[0]).toMatchObject({ causeIds: [CAUSE], effectiveFrom: 3n, previousCauseIds: [] });
    // Changed in epoch 3: waits for epoch 4; the epoch-3 list stays in effect.
    await sched([C2], 4n, "a2");
    expect(h.rows(shortlist)[0]).toMatchObject({ causeIds: [C2], effectiveFrom: 4n, previousCauseIds: [CAUSE] });
    // Changed again in epoch 3: the unapplied list is replaced, the in-effect one kept.
    await sched([C2, CAUSE], 4n, "a3");
    expect(h.rows(shortlist)[0]).toMatchObject({ causeIds: [C2, CAUSE], effectiveFrom: 4n, previousCauseIds: [CAUSE] });
    // Changed in epoch 6: the epoch-4 list has applied and becomes the previous one.
    await sched([], 7n, "a4");
    expect(h.rows(shortlist)[0]).toMatchObject({ causeIds: [], effectiveFrom: 7n, previousCauseIds: [C2, CAUSE] });
  });

  it("records the prepared ballot, its options and the clock", async () => {
    const opts = [CAUSE, C2];
    await run(
      onBallotPrepared,
      { token: T1, epoch: 3n, catalogVersion: 2, poolSize: 120n, pinned: 1, options: opts },
      "bp",
      block(20, zero + 3 * WEEK + 60),
    );
    expect(h.rows(epoch)[0]).toMatchObject({
      epoch: 3n,
      prepared: true,
      preparedAt: BigInt(zero + 3 * WEEK + 60),
      catalogVersion: 2,
      poolSize: 120n,
      pinnedCount: 1,
      opened: false,
    });
    expect(h.rows(epochOption).map((o) => o.causeId)).toEqual(opts);
    // EpochOpened right after does not duplicate the options.
    await run(onEpochOpened, { token: T1, epoch: 3n, options: opts }, "eo", block(20, zero + 3 * WEEK + 60));
    expect(h.rows(epochOption)).toHaveLength(2);
    expect(h.rows(epochClock)).toHaveLength(1);
  });

  it("records catalogue versions and token focus once", async () => {
    const root = `0x${"aa".repeat(32)}` as const;
    const ref = `0x${"bb".repeat(32)}` as const;
    await run(onCatalogVersionSet, { version: 1, root, swarmRef: ref, entries: 400_000n, setAt: 1000n }, "cv", block(1, 1000));
    await run(onCatalogVersionSet, { version: 1, root, swarmRef: ref, entries: 400_000n, setAt: 1000n }, "cv2", block(1, 1000));
    expect(h.rows(catalogVersion)).toEqual([
      { version: 1, root, swarmRef: ref, entries: 400_000n, setAt: 1000n, txHash: expect.any(String) },
    ]);
    await run(onFocusSet, { token: T1, categoryMask: 12n, regionMask: 3 }, "fs", block(2, 2000));
    expect(h.rows(tokenFocus)).toEqual([{ token: T1, categoryMask: 12n, regionMask: 3, setAt: 2000n }]);
    // TokenCreated, later in the same launch transaction, copies the focus onto the token row.
    const args = { token: T1, creator: T2, pool: `0x${"22".repeat(32)}`, hook: T2, lpTokenId: 7n, feeBps: 300, metadataURI: "" };
    await run(onTokenCreated, args, "tc", block(2, 2000));
    expect(h.rows(token)[0]).toMatchObject({ categoryMask: 12n, regionMask: 3 });
  });

  it("flags a timed-out tally fallback and a failed close that is retried", async () => {
    await run(onEpochCloseFailed, { token: T1, epoch: 3n }, "x", block(11, zero + 4 * WEEK + 5));
    expect(h.rows(epoch)[0]).toMatchObject({ closed: true, closeFailed: true });
    expect(h.rows(epoch)[0]?.closedAt ?? null).toBeNull();
    await run(onEpochClosed, { token: T1, epoch: 3n }, "y", block(12, zero + 4 * WEEK + 50));
    expect(h.rows(epoch)[0]).toMatchObject({ closed: true, closeFailed: false, closedAt: BigInt(zero + 4 * WEEK + 50) });
    await run(onTallyTimeoutFallbackApplied, { token: T1, epoch: 3n, causeId: CAUSE }, "t", block(13, zero + 7 * WEEK));
    await run(onEpochFinalized, { token: T1, epoch: 3n, causeId: CAUSE }, "f", block(13, zero + 7 * WEEK));
    expect(h.rows(epoch)[0]).toMatchObject({ fallbackApplied: true, fallbackReason: "timeout", winningCauseId: CAUSE });
    await run(onNoVoteFallbackApplied, { token: T1, epoch: 4n, causeId: CAUSE }, "n", block(14, zero + 7 * WEEK));
    expect(h.rows(epoch)[1]).toMatchObject({ epoch: 4n, fallbackApplied: true, fallbackReason: "no_votes" });
  });
});

describe("voting scheme", () => {
  const ref = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
  const k = { governor: GOV, token: T1, scope: 3n };

  it("tracks a poll from open to final counts and stores ballots once", async () => {
    await run(onPollOpened, { ...k, optionCount: 3 }, "p", block(1, 100), SCHEME);
    await run(onPollOpened, { ...k, optionCount: 3 }, "p2", block(1, 100), SCHEME);
    await run(onBallotCast, { ...k, voter: T2, weight: 40n, ballotRef: ref(1) }, "b1", block(2, 200), SCHEME);
    await run(onBallotCast, { ...k, voter: WETH, weight: 2n, ballotRef: ref(2) }, "b2", block(2, 210), SCHEME);
    await run(onBallotCast, { ...k, voter: WETH, weight: 2n, ballotRef: ref(2) }, "b2", block(2, 210), SCHEME);
    expect(h.rows(ballot)).toHaveLength(2);
    expect(h.rows(ballot)[0]).toMatchObject({ ...k, voter: T2, weight: 40n, castAt: 200n, txHash: tx.hash });
    await run(onTallyRequested, k, "r", block(3, 300), SCHEME);
    await run(onTallySubmitted, { ...k, counts: [2n, 40n, 0n] }, "s", block(4, 400), SCHEME);
    expect(h.rows(poll)).toEqual([
      {
        ...k,
        scheme: SCHEME,
        optionCount: 3,
        opened: true,
        closed: true,
        isFinal: true,
        ballotCount: 2,
        counts: [2n, 40n, 0n],
        openedAt: 100n,
        closedAt: 300n,
        finalAt: 400n,
      },
    ]);
  });

  it("ignores tally events for polls it never saw open", async () => {
    await run(onTallyRequested, k, "r", block(3, 300), SCHEME);
    await run(onTallySubmitted, { ...k, counts: [1n] }, "s", block(4, 400), SCHEME);
    await run(onBallotCast, { ...k, voter: T2, weight: 1n, ballotRef: ref(9) }, "b", block(2, 200), SCHEME);
    expect(h.rows(poll)).toHaveLength(0);
    expect(h.rows(ballot)).toHaveLength(1);
  });
});

describe("takeover governor", () => {
  const proposed = {
    token: T1,
    proposalId: 1n,
    proposer: T2,
    newController: ONDO,
    start: 1000,
    end: 1000 + 5 * 86_400,
    quorumWeight: 500n,
  };

  it("reads the execution deadline from getProposal and follows the lifecycle", async () => {
    const reads: string[] = [];
    reset(async ({ functionName, address, args }) => {
      reads.push(`${functionName}@${address}:${String(args?.[0])}`);
      if (functionName === "getProposal") {
        return { executionDeadline: proposed.end + 3 * 86_400, lookbackSnapshot: 900, circulatingWeight: 9_000n };
      }
      throw new Error("unexpected");
    });
    await run(onTakeoverProposed, proposed, "p", block(1, 1000), TAKEOVER);
    await run(onTakeoverProposed, proposed, "p", block(1, 1000), TAKEOVER);
    expect(reads).toEqual([`getProposal@${TAKEOVER}:1`]);
    const voteRef = `0x${"05".repeat(32)}` as const;
    await run(onTakeoverVoteCast, { token: T1, proposalId: 1n, voteRef }, "v", block(2, 2000), TAKEOVER);
    await run(onTakeoverVoteCast, { token: T1, proposalId: 1n, voteRef }, "v", block(2, 2000), TAKEOVER);
    expect(h.rows(takeoverVote)).toEqual([{ voteRef, token: T1, proposalId: 1n, castAt: 2000n }]);
    await run(onTakeoverClosed, { token: T1, proposalId: 1n }, "c", block(3, 3000), TAKEOVER);
    await run(onTakeoverTallied, { token: T1, proposalId: 1n, forWeight: 700n, againstWeight: 10n }, "t", block(4, 4000), TAKEOVER);
    await run(onTakeoverExecuted, { token: T1, proposalId: 1n, newController: ONDO }, "x", block(5, 5000), TAKEOVER);
    expect(h.rows(takeoverProposal)).toEqual([
      {
        proposalId: 1n,
        token: T1,
        proposer: T2,
        newController: ONDO,
        start: 1000n,
        end: BigInt(proposed.end),
        snapshot: 999n,
        executionDeadline: BigInt(proposed.end + 3 * 86_400),
        lookbackSnapshot: 900n,
        circulatingWeight: 9_000n,
        quorumWeight: 500n,
        forWeight: 700n,
        againstWeight: 10n,
        ballotCount: 1,
        closed: true,
        tallied: true,
        executed: true,
        canceled: false,
        createdAt: 1000n,
        closedAt: 3000n,
        talliedAt: 4000n,
        executedAt: 5000n,
        canceledAt: null,
        txHash: tx.hash,
        generation: 0,
      },
    ]);
  });

  it("stamps each proposal with the token's execution generation", async () => {
    await run(onTakeoverProposed, proposed, "p1", block(1, 1000), TAKEOVER);
    await run(onTakeoverProposed, { ...proposed, proposalId: 2n, proposer: WETH }, "p2", block(1, 1000), TAKEOVER);
    await run(onTakeoverProposed, { ...proposed, proposalId: 3n, token: T2 }, "p3", block(1, 1000), TAKEOVER);
    await run(onTakeoverExecuted, { token: T1, proposalId: 2n, newController: ONDO }, "x", block(5, 5000), TAKEOVER);
    await run(onTakeoverSuperseded, { token: T1, executedProposalId: 2n }, "s", block(5, 5000), TAKEOVER);
    await run(onTakeoverProposed, { ...proposed, proposalId: 4n }, "p4", block(6, 6000), TAKEOVER);
    await run(onTakeoverSuperseded, { token: T1, executedProposalId: 4n }, "s2", block(7, 7000), TAKEOVER);
    expect(h.rows(takeoverToken)).toEqual([{ token: T1, executions: 2, lastExecutedProposalId: 4n }]);
    expect(h.rows(takeoverProposal).map((p) => [p.proposalId, p.generation])).toEqual([
      [1n, 0],
      [2n, 0],
      [3n, 0],
      [4n, 1],
    ]);
  });

  it("falls back to params().executionWindow, then to an unknown deadline", async () => {
    reset(async ({ functionName }) => {
      if (functionName === "params") return { executionWindow: 3600 };
      throw new Error("reverted");
    });
    await run(onTakeoverProposed, proposed, "p", block(1, 1000), TAKEOVER);
    expect(h.rows(takeoverProposal)[0]).toMatchObject({
      executionDeadline: BigInt(proposed.end + 3600),
      lookbackSnapshot: null,
      circulatingWeight: null,
    });
    reset();
    await run(onTakeoverProposed, { ...proposed, proposalId: 2n }, "p", block(1, 1000), TAKEOVER);
    expect(h.rows(takeoverProposal)[0]).toMatchObject({ proposalId: 2n, executionDeadline: null });
  });

  it("marks cancellation and ignores events for unknown proposals", async () => {
    await run(onTakeoverProposed, proposed, "p", block(1, 1000), TAKEOVER);
    await run(onTakeoverCanceled, { token: T1, proposalId: 1n }, "x", block(2, 1500), TAKEOVER);
    await run(onTakeoverCanceled, { token: T1, proposalId: 9n }, "y", block(2, 1500), TAKEOVER);
    await run(onTakeoverExecuted, { token: T1, proposalId: 9n, newController: ONDO }, "z", block(2, 1500), TAKEOVER);
    expect(h.rows(takeoverProposal)).toHaveLength(1);
    expect(h.rows(takeoverProposal)[0]).toMatchObject({ canceled: true, canceledAt: 1500n, executed: false });
  });
});

describe("registrations", () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

  it("registers only events that the configured contract ABIs define", () => {
    const abiOf = new Map(
      [...read("ponder.config.ts").matchAll(/(\w+): \{\s*abi: (\w+),/g)].map((m) => [m[1]!, m[2]!]),
    );
    expect(abiOf.size).toBeGreaterThanOrEqual(11);
    const handlers = [...read("src/index.ts").matchAll(/ponder\.on\("(\w+):(\w+)"/g)];
    expect(handlers.length).toBeGreaterThan(40);
    for (const [, contract, name] of handlers) {
      const abi = (abis as Record<string, readonly { type: string; name?: string }[]>)[abiOf.get(contract!) ?? ""];
      expect(abi, contract).toBeDefined();
      expect(abi!.some((x) => x.type === "event" && x.name === name), `${contract}:${name}`).toBe(true);
    }
    for (const event of ["FeeVault:FeesAttributed", "FeeVault:Settled", "EpochGovernor:LaunchSnapshotSet"]) {
      expect(handlers.some((m) => `${m[1]}:${m[2]}` === event), event).toBe(true);
    }
  });
});

describe("curator agents", () => {
  it("records agents, curations, reports, opt-in donors and gifts", async () => {
    const {
      onAgentRegistered,
      onActiveSet,
      onCurationSet,
      onCurationsSubmitted,
      onVaultDonated,
      onVaultGiven,
    } = await import("../src/handlers/agents");
    const schema = await import("ponder:schema");
    const VAULT = "0x00000000000000000000000000000000000000fa";
    const REG = "0x00000000000000000000000000000000000000c0";
    h = createFakeContext(
      new Map<object, string[]>([
        [schema.agent, ["categoryBit"]],
        [schema.agentVault, ["vault"]],
        [schema.curation, ["bucket", "epoch"]],
        [schema.curationReport, ["categoryBit", "epoch"]],
        [schema.vaultDonation, ["id"]],
        [schema.vaultGift, ["id"]],
        [schema.agentTotal, ["categoryBit"]],
      ]),
      async () => ({ description: "Hunger curator" }),
    );
    const sig = "0x0000000000000000000000000000000000000051";
    await run(onAgentRegistered, { categoryBit: 2, agentId: 7n, label: "hunger", signer: sig, vault: VAULT }, "a1", block(1, 100), REG);
    expect(h.rows(schema.agent)[0]).toMatchObject({ categoryBit: 2, label: "hunger", vault: VAULT, active: true, description: "Hunger curator" });
    await run(onActiveSet, { categoryBit: 2, active: false }, "a2", block(2, 110), REG);
    expect(h.rows(schema.agent)[0]?.active).toBe(false);
    const root = `0x${"ab".repeat(32)}`;
    await run(onCurationSet, { bucket: 32, epoch: 6n, picksRoot: root, count: 3, weight: 7000, catalogVersion: 1 }, "c1", block(3, 120), REG);
    await run(onCurationSet, { bucket: 32, epoch: 6n, picksRoot: root, count: 4, weight: 5000, catalogVersion: 1 }, "c2", block(4, 130), REG);
    expect(h.rows(schema.curation)).toHaveLength(1);
    expect(h.rows(schema.curation)[0]).toMatchObject({ categoryBit: 2, regionBit: 0, count: 4, weight: 5000 });
    await run(onCurationsSubmitted, { categoryBit: 2, epoch: 6n, catalogVersion: 1, reportRef: root }, "c3", block(4, 130), REG);
    expect(h.rows(schema.curationReport)[0]).toMatchObject({ reportRef: root, epoch: 6n });
    await run(onVaultDonated, { from: sig, amount: 5n, credit: false }, "d1", block(5, 140), VAULT);
    await run(onVaultDonated, { from: sig, amount: 7n, credit: true }, "d2", block(6, 150), VAULT);
    expect(h.rows(schema.vaultDonation).map((d) => d.donor)).toEqual([null, sig]);
    await run(onVaultGiven, { epoch: 6n, regionBit: 0, orgId: root, org: VAULT, amount: 3n }, "g1", block(7, 160), VAULT);
    expect(h.rows(schema.agentTotal)[0]).toMatchObject({ donated: 12n, donations: 2, given: 3n, gifts: 1 });
  });
});
