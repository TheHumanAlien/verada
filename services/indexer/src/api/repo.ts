import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import type { Cursor } from "./cursor";
import {
  type ActivityItem,
  type ActivityKind,
  type ActivityQuery,
  type Repo,
  tieMode,
} from "./types";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const {
  token,
  feeTotal,
  feeCollection,
  feeConsolidation,
  cause,
  epoch,
  donation,
  vote,
  tokenProfile,
  tokenTextRecord,
  profileUpdate,
  epochClock,
  epochOption,
  shortlist,
  tokenFocus,
  poll,
  takeoverProposal,
  takeoverToken,
} = schema;

/** Byte-wise collation so SQL ordering matches the JS string comparison used for cursors. */
const collated = (expr: unknown) => sql`${expr} COLLATE "C"`;

interface Spec {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle table/column types differ per kind
  table: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  ts: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  key: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  token: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  where?: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  toItem(row: any): ActivityItem;
}

const SPECS: Record<ActivityKind, Spec> = {
  launch: {
    table: token,
    ts: token.createdAt,
    key: token.address,
    token: token.address,
    toItem: (r) => ({
      id: `launch:${r.address}`,
      kind: "launch",
      timestamp: r.createdAt,
      token: r.address,
      txHash: r.txHash,
      data: {
        creator: r.creator,
        pool: r.pool,
        hook: r.hook,
        lpTokenId: r.lpTokenId,
        feeBps: r.feeBps,
        metadataUri: r.metadataUri,
        blockNumber: r.createdBlock,
      },
    }),
  },
  fees: {
    table: feeCollection,
    ts: feeCollection.timestamp,
    key: feeCollection.id,
    token: feeCollection.token,
    toItem: (r) => ({
      id: `fees:${r.id}`,
      kind: "fees",
      timestamp: r.timestamp,
      token: r.token,
      txHash: r.txHash,
      data: { currency: r.currency, platformAmount: r.platformAmount, causeAmount: r.causeAmount },
    }),
  },
  consolidated: {
    table: feeConsolidation,
    ts: feeConsolidation.timestamp,
    key: feeConsolidation.id,
    token: feeConsolidation.token,
    toItem: (r) => ({
      id: `consolidated:${r.id}`,
      kind: "consolidated",
      timestamp: r.timestamp,
      token: r.token,
      txHash: r.txHash,
      data: { currencyIn: r.currencyIn, amountIn: r.amountIn, settlementOut: r.settlementOut },
    }),
  },
  donation: {
    table: donation,
    ts: donation.timestamp,
    key: donation.id,
    token: donation.token,
    toItem: (r) => ({
      id: `donation:${r.id}`,
      kind: "donation",
      timestamp: r.timestamp,
      token: r.token,
      txHash: r.txHash,
      data: { epoch: r.epoch, causeId: r.causeId, payout: r.payout, amount: r.amount },
    }),
  },
  vote: {
    table: vote,
    ts: vote.timestamp,
    key: vote.id,
    token: vote.token,
    toItem: (r) => ({
      id: `vote:${r.id}`,
      kind: "vote",
      timestamp: r.timestamp,
      token: r.token,
      txHash: null,
      data: { epoch: r.epoch, voteRef: r.voteRef },
    }),
  },
  epoch: {
    table: epoch,
    ts: epoch.finalizedAt,
    key: sql`(${epoch.token} || ':' || ${epoch.epoch}::text)`,
    token: epoch.token,
    where: isNotNull(epoch.finalizedAt),
    toItem: (r) => ({
      id: `epoch:${r.token}:${r.epoch}`,
      kind: "epoch",
      timestamp: r.finalizedAt,
      token: r.token,
      txHash: null,
      data: {
        epoch: r.epoch,
        winningCauseId: r.winningCauseId,
        voteCount: r.voteCount,
        donatedAmount: r.donatedAmount,
        donatedAt: r.donatedAt,
      },
    }),
  },
  token_registered: {
    table: tokenProfile,
    ts: tokenProfile.registeredAt,
    key: tokenProfile.token,
    token: tokenProfile.token,
    toItem: (r) => ({
      id: `token_registered:${r.token}`,
      kind: "token_registered",
      timestamp: r.registeredAt,
      token: r.token,
      txHash: r.txHash,
      data: { label: r.label, labelhash: r.labelhash },
    }),
  },
  profile_updated: {
    table: profileUpdate,
    ts: profileUpdate.timestamp,
    key: profileUpdate.id,
    token: profileUpdate.token,
    toItem: (r) => ({
      id: `profile_updated:${r.id}`,
      kind: "profile_updated",
      timestamp: r.timestamp,
      token: r.token,
      txHash: r.txHash,
      data: { field: r.field, key: r.key, value: r.value },
    }),
  },
  epoch_opened: {
    table: epoch,
    ts: epoch.openedAt,
    key: sql`(${epoch.token} || ':' || ${epoch.epoch}::text)`,
    token: epoch.token,
    where: isNotNull(epoch.openedAt),
    toItem: (r) => ({
      id: `epoch_opened:${r.token}:${r.epoch}`,
      kind: "epoch_opened",
      timestamp: r.openedAt,
      token: r.token,
      txHash: null,
      data: { epoch: r.epoch, governor: r.governor, scheme: r.scheme },
    }),
  },
  epoch_closed: {
    table: epoch,
    ts: epoch.closedAt,
    key: sql`(${epoch.token} || ':' || ${epoch.epoch}::text)`,
    token: epoch.token,
    where: isNotNull(epoch.closedAt),
    toItem: (r) => ({
      id: `epoch_closed:${r.token}:${r.epoch}`,
      kind: "epoch_closed",
      timestamp: r.closedAt,
      token: r.token,
      txHash: null,
      data: { epoch: r.epoch, voterCount: r.voterCount },
    }),
  },
  takeover_proposed: {
    table: takeoverProposal,
    ts: takeoverProposal.createdAt,
    key: sql`(${takeoverProposal.proposalId}::text)`,
    token: takeoverProposal.token,
    toItem: (r) => ({
      id: `takeover_proposed:${r.proposalId}`,
      kind: "takeover_proposed",
      timestamp: r.createdAt,
      token: r.token,
      txHash: r.txHash,
      data: {
        proposalId: r.proposalId,
        proposer: r.proposer,
        newController: r.newController,
        start: r.start,
        end: r.end,
        quorumWeight: r.quorumWeight,
      },
    }),
  },
  takeover_executed: {
    table: takeoverProposal,
    ts: takeoverProposal.executedAt,
    key: sql`(${takeoverProposal.proposalId}::text)`,
    token: takeoverProposal.token,
    where: isNotNull(takeoverProposal.executedAt),
    toItem: (r) => ({
      id: `takeover_executed:${r.proposalId}`,
      kind: "takeover_executed",
      timestamp: r.executedAt,
      token: r.token,
      txHash: null,
      data: {
        proposalId: r.proposalId,
        newController: r.newController,
        forWeight: r.forWeight,
        againstWeight: r.againstWeight,
      },
    }),
  },
  tally_submitted: {
    table: poll,
    ts: poll.finalAt,
    key: sql`(${poll.governor} || ':' || ${poll.token} || ':' || ${poll.scope}::text)`,
    token: poll.token,
    where: isNotNull(poll.finalAt),
    toItem: (r) => ({
      id: `tally_submitted:${r.governor}:${r.token}:${r.scope}`,
      kind: "tally_submitted",
      timestamp: r.finalAt,
      token: r.token,
      txHash: null,
      data: {
        governor: r.governor,
        scope: r.scope,
        optionCount: r.optionCount,
        ballotCount: r.ballotCount,
        counts: r.counts,
      },
    }),
  },
};

function cursorCondition(kind: ActivityKind, spec: Spec, before?: Cursor) {
  if (!before) return undefined;
  const ts = BigInt(before.t);
  const sep = before.k.indexOf(":");
  const cursorKind = sep < 0 ? "" : before.k.slice(0, sep);
  const cursorKey = sep < 0 ? before.k : before.k.slice(sep + 1);
  const mode = tieMode(kind, cursorKind);
  if (mode === "none") return lt(spec.ts, ts);
  if (mode === "all") return lte(spec.ts, ts);
  return or(
    lt(spec.ts, ts),
    and(eq(spec.ts, ts), sql`${collated(spec.key)} < ${cursorKey}`),
  );
}

const cmp = (a: ActivityItem, b: ActivityItem) =>
  a.timestamp !== b.timestamp ? (a.timestamp > b.timestamp ? -1 : 1) : a.id > b.id ? -1 : a.id < b.id ? 1 : 0;

async function listActivity(q: ActivityQuery): Promise<ActivityItem[]> {
  const kinds = q.kinds?.length ? q.kinds : (Object.keys(SPECS) as ActivityKind[]);
  const parts = await Promise.all(
    kinds.map(async (kind) => {
      const spec = SPECS[kind];
      const rows = await db
        .select()
        .from(spec.table)
        .where(
          and(
            spec.where,
            q.token ? eq(spec.token, q.token) : undefined,
            cursorCondition(kind, spec, q.before),
          ),
        )
        .orderBy(desc(spec.ts), desc(collated(spec.key)))
        .limit(q.limit);
      return rows.map((r: unknown) => spec.toItem(r));
    }),
  );
  return parts.flat().sort(cmp).slice(0, q.limit);
}

const big = (v: unknown) => BigInt((v ?? 0) as string | number | bigint);

export const repo: Repo = {
  async listTokens({ before, limit }) {
    const cond = before
      ? or(
          lt(token.createdAt, BigInt(before.t)),
          and(
            eq(token.createdAt, BigInt(before.t)),
            sql`${collated(token.address)} < ${before.k}`,
          ),
        )
      : undefined;
    return db
      .select()
      .from(token)
      .where(cond)
      .orderBy(desc(token.createdAt), desc(collated(token.address)))
      .limit(limit);
  },
  async getToken(address) {
    const [row] = await db.select().from(token).where(eq(token.address, address)).limit(1);
    if (!row) return null;
    const [fees] = await db.select().from(feeTotal).where(eq(feeTotal.token, address)).limit(1);
    const textRecords = await db
      .select({ key: tokenTextRecord.key, value: tokenTextRecord.value })
      .from(tokenTextRecord)
      .where(eq(tokenTextRecord.token, address))
      .orderBy(asc(tokenTextRecord.key));
    const [own] = await db.select().from(shortlist).where(eq(shortlist.token, address)).limit(1);
    const [focus] = await db
      .select({ categoryMask: tokenFocus.categoryMask, regionMask: tokenFocus.regionMask })
      .from(tokenFocus)
      .where(eq(tokenFocus.token, address))
      .limit(1);
    const [clock] = await db
      .select({ epochZeroStart: epochClock.epochZeroStart, epochLength: epochClock.epochLength })
      .from(epochClock)
      .where(eq(epochClock.id, "epoch_governor"))
      .limit(1);
    const schedule = (
      v: { causeIds: Hex[]; effectiveFrom: bigint | null; previousCauseIds: Hex[] } | undefined,
    ) =>
      v
        ? { causeIds: v.causeIds, effectiveFrom: v.effectiveFrom, previousCauseIds: v.previousCauseIds }
        : null;
    return {
      token: row,
      feeTotals: fees ?? null,
      textRecords,
      shortlist: schedule(own),
      focus: focus ?? null,
      clock: clock ?? null,
    };
  },
  async findTokenByLabel(label) {
    const [row] = await db
      .select({ address: token.address })
      .from(token)
      .where(eq(token.label, label))
      .limit(1);
    return row?.address ?? null;
  },
  async feeTotalsFor(addresses: Hex[]) {
    if (addresses.length === 0) return [];
    return db.select().from(feeTotal).where(inArray(feeTotal.token, addresses));
  },
  listActivity,
  async listCauses() {
    return db.select().from(cause).orderBy(cause.addedAt);
  },
  async listEpochs(t, { before, limit }) {
    return db
      .select()
      .from(epoch)
      .where(and(eq(epoch.token, t), before !== undefined ? lt(epoch.epoch, before) : undefined))
      .orderBy(desc(epoch.epoch))
      .limit(limit);
  },
  async getEpoch(t, n) {
    const [row] = await db
      .select()
      .from(epoch)
      .where(and(eq(epoch.token, t), eq(epoch.epoch, n)))
      .limit(1);
    if (!row) return null;
    const donations = await db
      .select()
      .from(donation)
      .where(and(eq(donation.token, t), eq(donation.epoch, n)))
      .orderBy(desc(donation.timestamp));
    const options = await db
      .select({ causeId: epochOption.causeId })
      .from(epochOption)
      .where(and(eq(epochOption.token, t), eq(epochOption.epoch, n)))
      .orderBy(asc(epochOption.index));
    const [p] = row.governor
      ? await db
          .select()
          .from(poll)
          .where(and(eq(poll.governor, row.governor), eq(poll.token, t), eq(poll.scope, n)))
          .limit(1)
      : [];
    const [clock] = await db
      .select({ epochZeroStart: epochClock.epochZeroStart, epochLength: epochClock.epochLength })
      .from(epochClock)
      .where(eq(epochClock.id, "epoch_governor"))
      .limit(1);
    return {
      epoch: row,
      donations,
      options: options.map((o: { causeId: Hex }) => o.causeId),
      poll: p ?? null,
      clock: clock ?? null,
    };
  },
  async listTakeovers(t, limit) {
    return db
      .select()
      .from(takeoverProposal)
      .where(eq(takeoverProposal.token, t))
      .orderBy(desc(takeoverProposal.proposalId))
      .limit(limit);
  },
  async getTakeover(id) {
    const [row] = await db
      .select()
      .from(takeoverProposal)
      .where(eq(takeoverProposal.proposalId, id))
      .limit(1);
    return row ?? null;
  },
  async takeoverExecutions(t) {
    const [row] = await db
      .select({ executions: takeoverToken.executions })
      .from(takeoverToken)
      .where(eq(takeoverToken.token, t))
      .limit(1);
    return row?.executions ?? 0;
  },
  async getPoll(governor, t, scope) {
    const [row] = await db
      .select()
      .from(poll)
      .where(and(eq(poll.governor, governor), eq(poll.token, t), eq(poll.scope, scope)))
      .limit(1);
    return row ?? null;
  },
  async stats() {
    const one = async <T>(p: Promise<T[]>) => (await p)[0]!;
    const tokens = await one(db.select({ n: count() }).from(token));
    const fees = await one(
      db
        .select({
          platform: sql<string>`coalesce(sum(${feeTotal.platformAmount}), 0)`,
          cause: sql<string>`coalesce(sum(${feeTotal.causeAmount}), 0)`,
        })
        .from(feeTotal),
    );
    const consolidated = await one(
      db
        .select({ out: sql<string>`coalesce(sum(${feeConsolidation.settlementOut}), 0)` })
        .from(feeConsolidation),
    );
    const donated = await one(
      db
        .select({ n: count(), amount: sql<string>`coalesce(sum(${donation.amount}), 0)` })
        .from(donation),
    );
    const votes = await one(db.select({ n: count() }).from(vote));
    const finalized = await one(
      db.select({ n: count() }).from(epoch).where(isNotNull(epoch.finalizedAt)),
    );
    const causes = await one(db.select({ n: count() }).from(cause).where(eq(cause.active, true)));
    return {
      tokens: Number(tokens.n),
      platformFees: big(fees.platform),
      causeFees: big(fees.cause),
      consolidatedUsdc: big(consolidated.out),
      donatedUsdc: big(donated.amount),
      donations: Number(donated.n),
      votes: Number(votes.n),
      epochsFinalized: Number(finalized.n),
      causes: Number(causes.n),
    };
  },
};
