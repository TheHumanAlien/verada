import type { Context, Event } from "ponder:registry";
import { quoteAsset } from "ponder:schema";

export async function onQuoteAssetAdded({
  event,
  context,
}: {
  event: Event<"QuoteRegistry:QuoteAssetAdded">;
  context: Context<"QuoteRegistry:QuoteAssetAdded">;
}) {
  const { asset, decimals, kind } = event.args;
  await context.db
    .insert(quoteAsset)
    .values({
      asset,
      decimals,
      kind,
      active: true,
      addedAt: event.block.timestamp,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoNothing();
}

async function setActive(
  context: { db: Context["db"] },
  asset: `0x${string}`,
  active: boolean,
  timestamp: bigint,
) {
  const existing = await context.db.find(quoteAsset, { asset });
  if (!existing) return;
  await context.db.update(quoteAsset, { asset }).set({ active, updatedAt: timestamp });
}

export async function onQuoteAssetDeactivated({
  event,
  context,
}: {
  event: Event<"QuoteRegistry:QuoteAssetDeactivated">;
  context: Context<"QuoteRegistry:QuoteAssetDeactivated">;
}) {
  await setActive(context, event.args.asset, false, event.block.timestamp);
}

export async function onQuoteAssetReactivated({
  event,
  context,
}: {
  event: Event<"QuoteRegistry:QuoteAssetReactivated">;
  context: Context<"QuoteRegistry:QuoteAssetReactivated">;
}) {
  await setActive(context, event.args.asset, true, event.block.timestamp);
}
