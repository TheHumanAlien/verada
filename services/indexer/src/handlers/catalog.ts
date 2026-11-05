import type { Context, Event } from "ponder:registry";
import { catalogVersion, token, tokenFocus } from "ponder:schema";

export async function onCatalogVersionSet({
  event,
  context,
}: {
  event: Event<"CauseCatalog:CatalogVersionSet">;
  context: Context<"CauseCatalog:CatalogVersionSet">;
}) {
  const { version, root, swarmRef, entries, setAt } = event.args;
  await context.db
    .insert(catalogVersion)
    .values({ version: Number(version), root, swarmRef, entries, setAt, txHash: event.transaction.hash })
    .onConflictDoNothing();
}

export async function onFocusSet({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:FocusSet">;
  context: Context<"TokenProfileRegistry:FocusSet">;
}) {
  const { token: address, categoryMask, regionMask } = event.args;
  await context.db
    .insert(tokenFocus)
    .values({ token: address, categoryMask, regionMask: Number(regionMask), setAt: event.block.timestamp })
    .onConflictDoNothing();
  // The registry sets the focus before the factory's `TokenCreated`; mirror it if the row exists.
  if (await context.db.find(token, { address })) {
    await context.db.update(token, { address }).set({ categoryMask, regionMask: Number(regionMask) });
  }
}
