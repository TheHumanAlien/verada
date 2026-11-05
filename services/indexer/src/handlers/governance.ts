import type { Context, Event } from "ponder:registry";
import { donation, epoch, orgDeployment, vote } from "ponder:schema";

type EpochDb = Context["db"];

async function ensureEpoch(db: EpochDb, token: `0x${string}`, epochNo: bigint) {
  const key = { token, epoch: epochNo };
  const row = await db.find(epoch, key);
  if (row) return row;
  await db.insert(epoch).values({ ...key, voteCount: 0 });
  return (await db.find(epoch, key))!;
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
    .set({ voteCount: row.voteCount + 1 });
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
