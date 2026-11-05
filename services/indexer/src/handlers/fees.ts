import type { Context, Event } from "ponder:registry";
import {
  causePoolAttribution,
  consolidationFailure,
  consolidationTotal,
  epoch,
  feeAttribution,
  feeCollection,
  feeConsolidation,
  feeTotal,
} from "ponder:schema";
import { ensureEpoch } from "./governance";

/**
 * The vault emits the settlement asset (USDC) as `currency`; amounts are 6-decimal USDC. One
 * event per deposit, carrying its totals; the per-epoch parts came just before as
 * `FeesAttributed`.
 */
export async function onFeesCollected({
  event,
  context,
}: {
  event: Event<"FeeVault:FeesCollected">;
  context: Context<"FeeVault:FeesCollected">;
}) {
  const { token, platformAmount, causeAmount, currency } = event.args;
  const existing = await context.db.find(feeTotal, { token });
  await context.db.insert(feeCollection).values({
    id: event.id,
    token,
    currency,
    platformAmount,
    causeAmount,
    depositSeq: (existing?.collections ?? 0) + 1,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });

  if (existing) {
    await context.db.update(feeTotal, { token }).set({
      platformAmount: existing.platformAmount + platformAmount,
      causeAmount: existing.causeAmount + causeAmount,
      collections: existing.collections + 1,
      lastCollectedAt: event.block.timestamp,
    });
  } else {
    await context.db.insert(feeTotal).values({
      token,
      settlementAsset: currency,
      platformAmount,
      causeAmount,
      collections: 1,
      lastCollectedAt: event.block.timestamp,
    });
  }
}

/**
 * One non-zero part of a deposit: `causeAmount` earned in `accrualEpoch` went to the pool of
 * `epoch` (the accrual epoch, or the first unsettled one after it). It does not touch
 * `fee_total`; the deposit's `FeesCollected` follows and counts once. Until then the token's
 * collection count is that of the previous deposit, which gives the part its `depositSeq`.
 */
export async function onFeesAttributed({
  event,
  context,
}: {
  event: Event<"FeeVault:FeesAttributed">;
  context: Context<"FeeVault:FeesAttributed">;
}) {
  const { token, epoch: epochNo, accrualEpoch, causeAmount } = event.args;
  if (await context.db.find(feeAttribution, { id: event.id })) return;
  const ts = event.block.timestamp;
  const depositSeq = ((await context.db.find(feeTotal, { token }))?.collections ?? 0) + 1;
  await context.db.insert(feeAttribution).values({
    id: event.id,
    token,
    epoch: epochNo,
    accrualEpoch,
    causeAmount,
    depositSeq,
    timestamp: ts,
    txHash: event.transaction.hash,
  });

  const key = { token, epoch: epochNo, accrualEpoch };
  const part = await context.db.find(causePoolAttribution, key);
  if (part) {
    await context.db.update(causePoolAttribution, key).set({
      causeAmount: part.causeAmount + causeAmount,
      parts: part.parts + 1,
      lastAttributedAt: ts,
    });
  } else {
    await context.db
      .insert(causePoolAttribution)
      .values({ ...key, causeAmount, parts: 1, firstAttributedAt: ts, lastAttributedAt: ts });
  }

  const row = await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ causeAttributed: row.causeAttributed + causeAmount });
}

/** The epoch's cause pool was paid to the distributor (once per epoch). */
export async function onSettled({
  event,
  context,
}: {
  event: Event<"FeeVault:Settled">;
  context: Context<"FeeVault:Settled">;
}) {
  const { token, epoch: epochNo, amount } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ settledAmount: amount, settledAt: event.block.timestamp });
}

async function bumpTotal(
  db: Context["db"],
  token: `0x${string}`,
  currencyIn: `0x${string}`,
  patch: (row: {
    consolidatedAmountIn: bigint;
    settlementOut: bigint;
    consolidations: number;
    failedAmountIn: bigint;
    failures: number;
  }) => Record<string, unknown>,
) {
  const key = { token, currencyIn };
  const row = await db.find(consolidationTotal, key);
  if (row) {
    await db.update(consolidationTotal, key).set(patch(row));
    return;
  }
  const zero = {
    consolidatedAmountIn: 0n,
    settlementOut: 0n,
    consolidations: 0,
    failedAmountIn: 0n,
    failures: 0,
  };
  await db.insert(consolidationTotal).values({
    ...key,
    ...zero,
    lastFailureAt: null,
    lastConsolidatedAt: null,
    ...patch(zero),
  });
}

export async function onFeesConsolidated({
  event,
  context,
}: {
  event: Event<"FeeConsolidator:FeesConsolidated">;
  context: Context<"FeeConsolidator:FeesConsolidated">;
}) {
  const { token, currencyIn, amountIn, settlementOut } = event.args;
  await context.db.insert(feeConsolidation).values({
    id: event.id,
    token,
    currencyIn,
    amountIn,
    settlementOut,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpTotal(context.db, token, currencyIn, (r) => ({
    consolidatedAmountIn: r.consolidatedAmountIn + amountIn,
    settlementOut: r.settlementOut + settlementOut,
    consolidations: r.consolidations + 1,
    lastConsolidatedAt: event.block.timestamp,
  }));
}

export async function onConsolidationFailed({
  event,
  context,
}: {
  event: Event<"FeeConsolidator:ConsolidationFailed">;
  context: Context<"FeeConsolidator:ConsolidationFailed">;
}) {
  const { token, currencyIn, amountIn, reason } = event.args;
  await context.db.insert(consolidationFailure).values({
    id: event.id,
    token,
    currencyIn,
    amountIn,
    reason,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpTotal(context.db, token, currencyIn, (r) => ({
    failedAmountIn: r.failedAmountIn + amountIn,
    failures: r.failures + 1,
    lastFailureAt: event.block.timestamp,
  }));
}
