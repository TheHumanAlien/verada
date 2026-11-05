import type { Context, Event } from "ponder:registry";
import { profileUpdate, token, tokenProfile, tokenTextRecord } from "ponder:schema";

type Hex = `0x${string}`;
type Db = Context["db"];

interface ProfilePatch {
  controller?: Hex | null;
  editor?: Hex | null;
  logoRef?: Hex | null;
  contenthash?: Hex | null;
  suppressed?: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}`;

/** Zero address or zero bytes32 become null so the API reports "unset" uniformly. */
const orNull = (v: Hex): Hex | null => (v === ZERO || v === ZERO32 || v === "0x" ? null : v);

/** Applies a patch to the profile row and mirrors it onto the token row when that exists. */
async function patchProfile(db: Db, address: Hex, patch: ProfilePatch) {
  if (await db.find(tokenProfile, { token: address })) {
    await db.update(tokenProfile, { token: address }).set(patch);
  }
  if (await db.find(token, { address })) {
    await db.update(token, { address }).set(patch);
  }
}

async function logUpdate(
  db: Db,
  event: { id: string; block: { timestamp: bigint }; transaction: { hash: Hex } },
  address: Hex,
  field: "controller" | "editor" | "text" | "logo" | "contenthash",
  value: string,
  key: string | null = null,
) {
  await db
    .insert(profileUpdate)
    .values({
      id: event.id,
      token: address,
      field,
      key,
      value,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
}

export async function onTokenRegistered({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:TokenRegistered">;
  context: Context<"TokenProfileRegistry:TokenRegistered">;
}) {
  const { token: address, labelhash, label, controller, logoRef } = event.args;
  const row = {
    label,
    labelhash,
    controller: orNull(controller),
    editor: null,
    logoRef: orNull(logoRef),
    contenthash: null,
    suppressed: false,
    registeredAt: event.block.timestamp,
  };
  await context.db
    .insert(tokenProfile)
    .values({ token: address, ...row, txHash: event.transaction.hash })
    .onConflictDoNothing();
  if (await context.db.find(token, { address })) {
    await context.db.update(token, { address }).set(row);
  }
}

export async function onControllerChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:ControllerChanged">;
  context: Context<"TokenProfileRegistry:ControllerChanged">;
}) {
  const { token: address, newController } = event.args;
  await patchProfile(context.db, address, { controller: orNull(newController) });
  await logUpdate(context.db, event, address, "controller", newController);
}

export async function onEditorChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:EditorChanged">;
  context: Context<"TokenProfileRegistry:EditorChanged">;
}) {
  const { token: address, editor } = event.args;
  await patchProfile(context.db, address, { editor: orNull(editor) });
  await logUpdate(context.db, event, address, "editor", editor);
}

export async function onTextChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:TextChanged">;
  context: Context<"TokenProfileRegistry:TextChanged">;
}) {
  // `indexedKey` is only the topic hash of the key; the plain key is in the data.
  const { token: address, key, value } = event.args;
  const pk = { token: address, key };
  const patch = { value, updatedAt: event.block.timestamp, updatedBlock: event.block.number };
  if (await context.db.find(tokenTextRecord, pk)) {
    await context.db.update(tokenTextRecord, pk).set(patch);
  } else {
    await context.db.insert(tokenTextRecord).values({ ...pk, ...patch });
  }
  await logUpdate(context.db, event, address, "text", value, key);
}

export async function onContenthashChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:ContenthashChanged">;
  context: Context<"TokenProfileRegistry:ContenthashChanged">;
}) {
  const { token: address, hash } = event.args;
  // Empty bytes clear the override; the registry default applies again.
  await patchProfile(context.db, address, { contenthash: hash === "0x" ? null : hash });
  await logUpdate(context.db, event, address, "contenthash", hash);
}

export async function onLogoChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:LogoChanged">;
  context: Context<"TokenProfileRegistry:LogoChanged">;
}) {
  const { token: address, logoRef } = event.args;
  await patchProfile(context.db, address, { logoRef: orNull(logoRef) });
  // `register` emits the initial logo right after `TokenRegistered`; that is not an update.
  const profile = await context.db.find(tokenProfile, { token: address });
  if (profile?.txHash === event.transaction.hash) return;
  await logUpdate(context.db, event, address, "logo", logoRef);
}

export async function onSuppressionChanged({
  event,
  context,
}: {
  event: Event<"TokenProfileRegistry:SuppressionChanged">;
  context: Context<"TokenProfileRegistry:SuppressionChanged">;
}) {
  const { token: address, suppressed } = event.args;
  await patchProfile(context.db, address, { suppressed });
}
