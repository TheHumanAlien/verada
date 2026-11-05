import type { Context, Event } from "ponder:registry";
import { EPOCH_LENGTH, alignToThursday } from "@verada/sdk";
import {
  donation,
  epoch,
  epochClock,
  epochOption,
  orgDeployment,
  poll,
  shortlist,
  vote,
} from "ponder:schema";

type EpochDb = Context["db"];
type Hex = `0x${string}`;

/** Returns the `(token, epoch)` row, inserting an empty one first if needed. */
export async function ensureEpoch(db: EpochDb, token: Hex, epochNo: bigint) {
  const key = { token, epoch: epochNo };
  const row = await db.find(epoch, key);
  if (row) return row;
  await db.insert(epoch).values({
    ...key,
    voteCount: 0,
    opened: false,
    closed: false,
    voterCount: 0,
    fallbackApplied: false,
    fallbackReason: null,
    closeFailed: false,
    causeAttributed: 0n,
  });
  return (await db.find(epoch, key))!;
}

/**
 * Records the governor's `epochZeroStart` the first time an event proves which epoch is current
 * (`EpochOpened` and `VoteCast` only happen during the epoch they name). Epoch starts are whole
 * weeks since unix time 0, so the current epoch's start is the timestamp aligned down to a week.
 */
async function recordClock(db: EpochDb, epochNo: bigint, timestamp: bigint) {
  if (await db.find(epochClock, { id: "epoch_governor" })) return;
  const zero = alignToThursday(timestamp) - epochNo * EPOCH_LENGTH;
  if (zero < 0n) return;
  await db
    .insert(epochClock)
    .values({ id: "epoch_governor", epochZeroStart: zero, epochLength: EPOCH_LENGTH })
    .onConflictDoNothing();
}

export async function onVoteCast({
  event,
  context,
}: {
  event: Event<"EpochGovernor:VoteCast">;
  context: Context<"EpochGovernor:VoteCast">;
}) {
  const { token, epoch: epochNo, voteRef } = event.args;
  await context.db.insert(vote).values({
    id: event.id,
    token,
    epoch: epochNo,
    voteRef,
    timestamp: event.block.timestamp,
  });
  const row = await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ voteCount: row.voteCount + 1, voterCount: row.voterCount + 1 });
  await recordClock(context.db, epochNo, event.block.timestamp);
}

export async function onEpochOpened({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochOpened">;
  context: Context<"EpochGovernor:EpochOpened">;
}) {
  const { token, epoch: epochNo, options } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  for (const [index, causeId] of options.entries()) {
    await context.db
      .insert(epochOption)
      .values({ token, epoch: epochNo, index, causeId })
      .onConflictDoNothing();
  }
  // The scheme opened its poll just before, in the same call; null if that scheme is not indexed.
  const p = await context.db.find(poll, { governor: event.log.address, token, scope: epochNo });
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    opened: true,
    openedAt: event.block.timestamp,
    governor: event.log.address,
    scheme: p?.scheme ?? null,
  });
  await recordClock(context.db, epochNo, event.block.timestamp);
}

/**
 * A token registered without supply at its launch epoch's regular snapshot gets a snapshot inside
 * that epoch; `snapshotFor(token, epoch)` returns it instead of `snapshotOf(epoch)`. Emitted by
 * `registerToken` during the epoch it names, so it also fixes the clock.
 */
export async function onLaunchSnapshotSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:LaunchSnapshotSet">;
  context: Context<"EpochGovernor:LaunchSnapshotSet">;
}) {
  const { token, epoch: epochNo, snapshot } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db.update(epoch, { token, epoch: epochNo }).set({ launchSnapshot: snapshot });
  await recordClock(context.db, epochNo, event.block.timestamp);
}

/**
 * The epoch's ballot is fixed: pins first, then rotation draws. Options are stored here as well as
 * on `EpochOpened`, because a ballot with fewer than two options is prepared but never opened.
 */
export async function onBallotPrepared({
  event,
  context,
}: {
  event: Event<"EpochGovernor:BallotPrepared">;
  context: Context<"EpochGovernor:BallotPrepared">;
}) {
  const { token, epoch: epochNo, catalogVersion, poolSize, pinned, options } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  for (const [index, causeId] of options.entries()) {
    await context.db
      .insert(epochOption)
      .values({ token, epoch: epochNo, index, causeId })
      .onConflictDoNothing();
  }
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    prepared: true,
    preparedAt: event.block.timestamp,
    catalogVersion: Number(catalogVersion),
    poolSize,
    pinnedCount: Number(pinned),
  });
  await recordClock(context.db, epochNo, event.block.timestamp);
}

export async function onEpochClosed({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochClosed">;
  context: Context<"EpochGovernor:EpochClosed">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // A successful (re)close requests the tally; it clears an earlier failure.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ closed: true, closedAt: event.block.timestamp, closeFailed: false });
}

export async function onEpochCloseFailed({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochCloseFailed">;
  context: Context<"EpochGovernor:EpochCloseFailed">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // On-chain the epoch counts as closed but may be closed again; no tally was requested.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ closed: true, closeFailed: true });
}

export async function onNoVoteFallbackApplied({
  event,
  context,
}: {
  event: Event<"EpochGovernor:NoVoteFallbackApplied">;
  context: Context<"EpochGovernor:NoVoteFallbackApplied">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // `EpochFinalized` follows in the same transaction and stores the winner.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ fallbackApplied: true, fallbackReason: "no_votes" });
}

export async function onTallyTimeoutFallbackApplied({
  event,
  context,
}: {
  event: Event<"EpochGovernor:TallyTimeoutFallbackApplied">;
  context: Context<"EpochGovernor:TallyTimeoutFallbackApplied">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // Ballots were cast but no valid tally arrived within the grace period.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ fallbackApplied: true, fallbackReason: "timeout" });
}

interface Schedule {
  causeIds: Hex[];
  effectiveFrom: bigint | null;
  previousCauseIds: Hex[];
}

/**
 * Applies a `*Scheduled(effectiveFrom, causes)` to the stored schedule like `_schedule` does.
 * The governor returns the current epoch (immediate) or the next one, so the current epoch is
 * at least `effectiveFrom - 1`: an older list scheduled from before that is in effect now and
 * becomes the previous list; otherwise the previous list stays (an unapplied list is replaced).
 */
export function nextSchedule(old: Schedule | null, causes: readonly Hex[], from: bigint): Schedule {
  const oldInEffect = old?.effectiveFrom != null && old.effectiveFrom <= from - 1n;
  return {
    causeIds: [...causes],
    effectiveFrom: from,
    previousCauseIds: oldInEffect ? old!.causeIds : (old?.previousCauseIds ?? []),
  };
}

/** Records the clock from the governor's `epochZeroStart` when no epoch event has yet. */
async function clockFromChain(
  context: Context<"EpochGovernor:ShortlistScheduled">,
  address: Hex,
) {
  if (await context.db.find(epochClock, { id: "epoch_governor" })) return;
  try {
    const zero = await context.client.readContract({
      abi: context.contracts.EpochGovernor.abi,
      address,
      functionName: "epochZeroStart",
    });
    await context.db
      .insert(epochClock)
      .values({ id: "epoch_governor", epochZeroStart: BigInt(zero), epochLength: EPOCH_LENGTH })
      .onConflictDoNothing();
  } catch {
    // Derived later from the first EpochOpened or VoteCast.
  }
}

/** Legacy event, emitted just before `ShortlistScheduled`; only used until that is seen. */
export async function onShortlistSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:ShortlistSet">;
  context: Context<"EpochGovernor:ShortlistSet">;
}) {
  const { token, causes } = event.args;
  const row = await context.db.find(shortlist, { token });
  if (row?.scheduled) return;
  const patch = { causeIds: [...causes], updatedAt: event.block.timestamp };
  if (row) await context.db.update(shortlist, { token }).set(patch);
  else {
    await context.db
      .insert(shortlist)
      .values({ token, ...patch, effectiveFrom: null, previousCauseIds: [], scheduled: false });
  }
}

export async function onShortlistScheduled({
  event,
  context,
}: {
  event: Event<"EpochGovernor:ShortlistScheduled">;
  context: Context<"EpochGovernor:ShortlistScheduled">;
}) {
  const { token, effectiveFrom, causes } = event.args;
  const row = await context.db.find(shortlist, { token });
  const next = { ...nextSchedule(row, causes, effectiveFrom), scheduled: true, updatedAt: event.block.timestamp };
  if (row) await context.db.update(shortlist, { token }).set(next);
  else await context.db.insert(shortlist).values({ token, ...next });
  await clockFromChain(context, event.log.address);
}

export async function onEpochFinalized({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochFinalized">;
  context: Context<"EpochGovernor:EpochFinalized">;
}) {
  const { token, epoch: epochNo, causeId } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ winningCauseId: causeId, finalizedAt: event.block.timestamp });
}

export async function onDonated({
  event,
  context,
}: {
  event: Event<"DonationDistributor:Donated">;
  context: Context<"DonationDistributor:Donated">;
}) {
  const { token, epoch: epochNo, causeId, payout, amount } = event.args;
  await context.db.insert(donation).values({
    id: event.id,
    token,
    epoch: epochNo,
    causeId,
    payout,
    amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  const row = await ensureEpoch(context.db, token, epochNo);
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    donatedAmount: (row.donatedAmount ?? 0n) + amount,
    donatedPayout: payout,
    donatedAt: event.block.timestamp,
  });
}

export async function onOrgDeployed({
  event,
  context,
}: {
  event: Event<"DonationDistributor:OrgDeployed">;
  context: Context<"DonationDistributor:OrgDeployed">;
}) {
  const { orgId, org } = event.args;
  await context.db
    .insert(orgDeployment)
    .values({ orgId, org, deployedAt: event.block.timestamp, txHash: event.transaction.hash })
    .onConflictDoNothing();
}
