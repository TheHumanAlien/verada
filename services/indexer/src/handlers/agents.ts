import type { Context, Event } from "ponder:registry";
import { agent, agentTotal, agentVault, curation, curationReport, vaultDonation, vaultGift } from "ponder:schema";

type Db = Context["db"];

async function bumpTotals(db: Db, categoryBit: number, patch: { donated?: bigint; given?: bigint }) {
  const row = await db.find(agentTotal, { categoryBit });
  const next = {
    donated: (row?.donated ?? 0n) + (patch.donated ?? 0n),
    donations: (row?.donations ?? 0) + (patch.donated !== undefined ? 1 : 0),
    given: (row?.given ?? 0n) + (patch.given ?? 0n),
    gifts: (row?.gifts ?? 0) + (patch.given !== undefined ? 1 : 0),
  };
  if (row) await db.update(agentTotal, { categoryBit }).set(next);
  else await db.insert(agentTotal).values({ categoryBit, ...next });
}

export async function onAgentRegistered({ event, context }: { event: Event<"CuratorRegistry:AgentRegistered">; context: Context<"CuratorRegistry:AgentRegistered"> }) {
  const { categoryBit, agentId, label, signer, vault } = event.args;
  const c = Number(categoryBit);
  let description = "";
  try {
    const a = await context.client.readContract({ abi: context.contracts.CuratorRegistry.abi, address: event.log.address, functionName: "agentOf", args: [categoryBit] });
    description = a.description;
  } catch {
    // Filled by a later DescriptionSet.
  }
  await context.db
    .insert(agent)
    .values({ categoryBit: c, agentId, label, signer, vault, active: true, description, agentURI: null, registeredAt: event.block.timestamp })
    .onConflictDoNothing();
  await context.db.insert(agentVault).values({ vault, categoryBit: c }).onConflictDoNothing();
}

export async function onSignerSet({ event, context }: { event: Event<"CuratorRegistry:SignerSet">; context: Context<"CuratorRegistry:SignerSet"> }) {
  const c = Number(event.args.categoryBit);
  if (await context.db.find(agent, { categoryBit: c })) await context.db.update(agent, { categoryBit: c }).set({ signer: event.args.signer });
}

export async function onActiveSet({ event, context }: { event: Event<"CuratorRegistry:ActiveSet">; context: Context<"CuratorRegistry:ActiveSet"> }) {
  const c = Number(event.args.categoryBit);
  if (await context.db.find(agent, { categoryBit: c })) await context.db.update(agent, { categoryBit: c }).set({ active: event.args.active });
}

export async function onDescriptionSet({ event, context }: { event: Event<"CuratorRegistry:DescriptionSet">; context: Context<"CuratorRegistry:DescriptionSet"> }) {
  const c = Number(event.args.categoryBit);
  if (await context.db.find(agent, { categoryBit: c })) await context.db.update(agent, { categoryBit: c }).set({ description: event.args.description });
}

export async function onAgentURISet({ event, context }: { event: Event<"CuratorRegistry:AgentURISet">; context: Context<"CuratorRegistry:AgentURISet"> }) {
  const c = Number(event.args.categoryBit);
  if (await context.db.find(agent, { categoryBit: c })) await context.db.update(agent, { categoryBit: c }).set({ agentURI: event.args.agentURI });
}

export async function onAgentWalletLinked({ event, context }: { event: Event<"CuratorRegistry:AgentWalletLinked">; context: Context<"CuratorRegistry:AgentWalletLinked"> }) {
  const c = Number(event.args.categoryBit);
  if (await context.db.find(agent, { categoryBit: c })) await context.db.update(agent, { categoryBit: c }).set({ walletLinked: true });
}

export async function onCurationSet({ event, context }: { event: Event<"CuratorRegistry:CurationSet">; context: Context<"CuratorRegistry:CurationSet"> }) {
  const { bucket, epoch, picksRoot, count, weight, catalogVersion } = event.args;
  const key = { bucket: Number(bucket), epoch };
  const row = {
    categoryBit: Math.floor(Number(bucket) / 16),
    regionBit: Number(bucket) % 16,
    picksRoot,
    count: Number(count),
    weight: Number(weight),
    catalogVersion: Number(catalogVersion),
    submittedAt: event.block.timestamp,
  };
  if (await context.db.find(curation, key)) await context.db.update(curation, key).set(row);
  else await context.db.insert(curation).values({ ...key, ...row });
}

export async function onCurationsSubmitted({ event, context }: { event: Event<"CuratorRegistry:CurationsSubmitted">; context: Context<"CuratorRegistry:CurationsSubmitted"> }) {
  const { categoryBit, epoch, catalogVersion, reportRef } = event.args;
  const key = { categoryBit: Number(categoryBit), epoch };
  const row = { catalogVersion: Number(catalogVersion), reportRef, submittedAt: event.block.timestamp, txHash: event.transaction.hash };
  if (await context.db.find(curationReport, key)) await context.db.update(curationReport, key).set(row);
  else await context.db.insert(curationReport).values({ ...key, ...row });
}

export async function onVaultDonated({ event, context }: { event: Event<"AgentVault:Donated">; context: Context<"AgentVault:Donated"> }) {
  const v = await context.db.find(agentVault, { vault: event.log.address });
  if (!v) return;
  const { from, amount, credit } = event.args;
  await context.db.insert(vaultDonation).values({
    id: event.id,
    categoryBit: v.categoryBit,
    // Opt-in credit: the donor is stored only when they asked to be named.
    donor: credit ? from : null,
    amount,
    credit,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpTotals(context.db, v.categoryBit, { donated: amount });
}

export async function onVaultGiven({ event, context }: { event: Event<"AgentVault:Given">; context: Context<"AgentVault:Given"> }) {
  const v = await context.db.find(agentVault, { vault: event.log.address });
  if (!v) return;
  const { epoch, regionBit, orgId, org, amount } = event.args;
  await context.db.insert(vaultGift).values({
    id: event.id,
    categoryBit: v.categoryBit,
    epoch,
    regionBit: Number(regionBit),
    orgId,
    org,
    amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpTotals(context.db, v.categoryBit, { given: amount });
}
