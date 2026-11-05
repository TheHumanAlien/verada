import type { Context, Event } from "ponder:registry";
import { token } from "ponder:schema";

export async function onTokenCreated({
  event,
  context,
}: {
  event: Event<"Factory:TokenCreated">;
  context: Context<"Factory:TokenCreated">;
}) {
  const a = event.args;
  await context.db
    .insert(token)
    .values({
      address: a.token,
      creator: a.creator,
      pool: a.pool,
      hook: a.hook,
      lpTokenId: a.lpTokenId,
      feeBps: a.feeBps,
      metadataUri: a.metadataURI,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
}
