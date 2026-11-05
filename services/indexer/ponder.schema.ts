import { index, onchainTable, primaryKey, relations } from "ponder";

export const token = onchainTable(
  "token",
  (t) => ({
    address: t.hex().primaryKey(),
    creator: t.hex().notNull(),
    pool: t.hex().notNull(),
    hook: t.hex().notNull(),
    lpTokenId: t.bigint().notNull(),
    feeBps: t.integer().notNull(),
    metadataUri: t.text().notNull(),
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
    createdAtIdx: index().on(table.createdAt),
  }),
);

/**
 * Running fee totals per token. Everything is denominated in the settlement asset (USDC,
 * 6 decimals), so a single row per token is the full accounting picture.
 */
export const feeTotal = onchainTable(
  "fee_total",
  (t) => ({
    token: t.hex().primaryKey(),
    /** Settlement asset the amounts are denominated in (USDC). */
    settlementAsset: t.hex().notNull(),
    platformAmount: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    collections: t.integer().notNull(),
    lastCollectedAt: t.bigint().notNull(),
  }),
);

export const feeCollection = onchainTable(
  "fee_collection",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    /** Settlement asset (USDC). */
    currency: t.hex().notNull(),
    platformAmount: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/** One successful swap of collected fees (token side or quote side) into the settlement asset. */
export const feeConsolidation = onchainTable(
  "fee_consolidation",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    settlementOut: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/** A failed consolidation route. The fees stay held in the consolidator for retry. */
export const consolidationFailure = onchainTable(
  "consolidation_failure",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    reason: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/**
 * Cumulative consolidation counters per (token, input currency). The authoritative held balance
 * is `FeeConsolidator.heldFees(token, currency)` on-chain; `failedAmountIn - recoveredAmountIn`
 * is not tracked because a successful event does not say whether it came from a retry.
 */
export const consolidationTotal = onchainTable(
  "consolidation_total",
  (t) => ({
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    consolidatedAmountIn: t.bigint().notNull(),
    settlementOut: t.bigint().notNull(),
    consolidations: t.integer().notNull(),
    failedAmountIn: t.bigint().notNull(),
    failures: t.integer().notNull(),
    lastFailureAt: t.bigint(),
    lastConsolidatedAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.currencyIn] }),
  }),
);

/** Allowlisted quote assets (WETH and Ondo tokenized assets) from the quote registry. */
export const quoteAsset = onchainTable("quote_asset", (t) => ({
  asset: t.hex().primaryKey(),
  decimals: t.integer().notNull(),
  /** 0 = Native (WETH), 1 = Ondo. */
  kind: t.integer().notNull(),
  active: t.boolean().notNull(),
  addedAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** Endaoment orgs deployed by the distributor on first donation. */
export const orgDeployment = onchainTable("org_deployment", (t) => ({
  orgId: t.hex().primaryKey(),
  org: t.hex().notNull(),
  deployedAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const cause = onchainTable("cause", (t) => ({
  causeId: t.hex().primaryKey(),
  /** The nonprofit's Endaoment org address (deterministic CREATE2 address, may not be deployed yet). */
  payout: t.hex().notNull(),
  active: t.boolean().notNull(),
  addedAt: t.bigint().notNull(),
  deactivatedAt: t.bigint(),
}));

export const epoch = onchainTable(
  "epoch",
  (t) => ({
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    winningCauseId: t.hex(),
    finalizedAt: t.bigint(),
    voteCount: t.integer().notNull(),
    donatedAmount: t.bigint(),
    donatedPayout: t.hex(),
    donatedAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.epoch] }),
    winnerIdx: index().on(table.winningCauseId),
  }),
);

export const donation = onchainTable(
  "donation",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    causeId: t.hex().notNull(),
    payout: t.hex().notNull(),
    /** Gross USDC (6 decimals) sent to the org, before Endaoment's own fee. */
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    causeIdx: index().on(table.causeId),
  }),
);

export const vote = onchainTable(
  "vote",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    voteRef: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    tokenEpochIdx: index().on(table.token, table.epoch),
  }),
);

export const tokenRelations = relations(token, ({ many }) => ({
  feeTotals: many(feeTotal),
  epochs: many(epoch),
  donations: many(donation),
}));

export const feeTotalRelations = relations(feeTotal, ({ one }) => ({
  tokenRef: one(token, { fields: [feeTotal.token], references: [token.address] }),
}));

export const epochRelations = relations(epoch, ({ one }) => ({
  tokenRef: one(token, { fields: [epoch.token], references: [token.address] }),
  winnerCause: one(cause, { fields: [epoch.winningCauseId], references: [cause.causeId] }),
}));

export const donationRelations = relations(donation, ({ one }) => ({
  tokenRef: one(token, { fields: [donation.token], references: [token.address] }),
  causeRef: one(cause, { fields: [donation.causeId], references: [cause.causeId] }),
}));
