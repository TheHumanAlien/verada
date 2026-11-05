import type { Context, Event } from "ponder:registry";
import {
  consolidationFailure,
  consolidationTotal,
  feeCollection,
  feeConsolidation,
  feeTotal,
} from "ponder:schema";

/** The vault emits the settlement asset (USDC) as `currency`; amounts are 6-decimal USDC. */
export async function onFeesCollected({
  event,
  context,
}: {
  event: Event<"FeeVault:FeesCollected">;
  context: Context<"FeeVault:FeesCollected">;
}) {
  const { token, platformAmount, causeAmount, currency } = event.args;
  await context.db.insert(feeCollection).values({
    id: event.id,
    token,
    currency,
    platformAmount,
    causeAmount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });

  const existing = await context.db.find(feeTotal, { token });
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
