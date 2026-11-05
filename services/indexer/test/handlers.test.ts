import { beforeEach, describe, expect, it } from "vitest";
import {
  cause,
  consolidationFailure,
  consolidationTotal,
  donation,
  epoch,
  feeCollection,
  feeConsolidation,
  feeTotal,
  orgDeployment,
  quoteAsset,
  token,
  vote,
} from "ponder:schema";
import { onCauseAdded, onCauseDeactivated, onPayoutUpdated } from "../src/handlers/causes";
import { onConsolidationFailed, onFeesCollected, onFeesConsolidated } from "../src/handlers/fees";
import { onDonated, onEpochFinalized, onOrgDeployed, onVoteCast } from "../src/handlers/governance";
import {
  onQuoteAssetAdded,
  onQuoteAssetDeactivated,
  onQuoteAssetReactivated,
} from "../src/handlers/quote";
import { onTokenCreated } from "../src/handlers/token";
import { createFakeContext } from "./fakeDb";

const T1 = "0x00000000000000000000000000000000000000a1" as const;
const T2 = "0x00000000000000000000000000000000000000a2" as const;
const WETH = "0x00000000000000000000000000000000000000b1" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const ONDO = "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c" as const;
const CAUSE = `0x${"11".repeat(32)}` as const;
const tx = { hash: `0x${"ab".repeat(32)}` as const };

let h: ReturnType<typeof createFakeContext>;
const block = (n: number, ts: number) => ({ number: BigInt(n), timestamp: BigInt(ts) });
// biome-ignore lint/suspicious/noExplicitAny: test shim for event payloads
const run = (fn: any, args: object, id = "e1", b = block(1, 100)) =>
  fn({ event: { args, block: b, transaction: tx, id }, context: h.context });

beforeEach(() => {
  h = createFakeContext(
    new Map<object, string[]>([
      [token, ["address"]],
      [feeTotal, ["token"]],
      [feeCollection, ["id"]],
      [feeConsolidation, ["id"]],
      [consolidationFailure, ["id"]],
      [consolidationTotal, ["token", "currencyIn"]],
      [quoteAsset, ["asset"]],
      [orgDeployment, ["orgId"]],
      [cause, ["causeId"]],
      [epoch, ["token", "epoch"]],
      [donation, ["id"]],
      [vote, ["id"]],
    ]),
  );
});

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
  });
});

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
