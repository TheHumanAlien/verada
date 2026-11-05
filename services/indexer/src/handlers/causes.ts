import type { Context, Event } from "ponder:registry";
import { cause } from "ponder:schema";

export async function onCauseAdded({
  event,
  context,
}: {
  event: Event<"CauseRegistry:CauseAdded">;
  context: Context<"CauseRegistry:CauseAdded">;
}) {
  const { causeId, payout } = event.args;
  const existing = await context.db.find(cause, { causeId });
  if (existing) {
    // Re-adding (or updating the payout of) a known cause reactivates it.
    await context.db
      .update(cause, { causeId })
      .set({ payout, active: true, deactivatedAt: null });
    return;
  }
  await context.db.insert(cause).values({
    causeId,
    payout,
    active: true,
    addedAt: event.block.timestamp,
    deactivatedAt: null,
  });
}

export async function onCauseDeactivated({
  event,
  context,
}: {
  event: Event<"CauseRegistry:CauseDeactivated">;
  context: Context<"CauseRegistry:CauseDeactivated">;
}) {
  const { causeId } = event.args;
  const existing = await context.db.find(cause, { causeId });
  if (!existing) return;
  await context.db
    .update(cause, { causeId })
    .set({ active: false, deactivatedAt: event.block.timestamp });
}

export async function onPayoutUpdated({
  event,
  context,
}: {
  event: Event<"CauseRegistry:PayoutUpdated">;
  context: Context<"CauseRegistry:PayoutUpdated">;
}) {
  const { causeId, newPayout } = event.args;
  const existing = await context.db.find(cause, { causeId });
  if (!existing) return;
  await context.db.update(cause, { causeId }).set({ payout: newPayout });
}
