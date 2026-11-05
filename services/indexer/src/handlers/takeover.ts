import type { Context, Event } from "ponder:registry";
import { takeoverProposal, takeoverVote } from "ponder:schema";

/**
 * The event omits the execution deadline. It is read from `getProposal` at the proposal block
 * (exact: parameters are captured per proposal), else derived from `params().executionWindow`
 * at that block, else left null (the API then never reports `Expired`).
 */
async function readDeadline(
  event: Event<"TakeoverGovernor:TakeoverProposed">,
  context: Context<"TakeoverGovernor:TakeoverProposed">,
): Promise<bigint | null> {
  const abi = context.contracts.TakeoverGovernor.abi;
  const address = event.log.address;
  try {
    const p = await context.client.readContract({
      abi,
      address,
      functionName: "getProposal",
      args: [event.args.proposalId],
    });
    return BigInt(p.executionDeadline);
  } catch {
    try {
      const params = await context.client.readContract({ abi, address, functionName: "params" });
      return BigInt(event.args.end) + BigInt(params.executionWindow);
    } catch {
      return null;
    }
  }
}

export async function onTakeoverProposed({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverProposed">;
  context: Context<"TakeoverGovernor:TakeoverProposed">;
}) {
  const { token, proposalId, proposer, newController, start, end, quorumWeight } = event.args;
  if (await context.db.find(takeoverProposal, { proposalId })) return;
  const executionDeadline = await readDeadline(event, context);
  await context.db.insert(takeoverProposal).values({
    proposalId,
    token,
    proposer,
    newController,
    start: BigInt(start),
    end: BigInt(end),
    // Weights are read one second before the proposal was created.
    snapshot: BigInt(start) - 1n,
    executionDeadline,
    quorumWeight,
    forWeight: 0n,
    againstWeight: 0n,
    ballotCount: 0,
    closed: false,
    tallied: false,
    executed: false,
    canceled: false,
    createdAt: event.block.timestamp,
    closedAt: null,
    talliedAt: null,
    executedAt: null,
    canceledAt: null,
    txHash: event.transaction.hash,
  });
}

export async function onTakeoverVoteCast({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverVoteCast">;
  context: Context<"TakeoverGovernor:TakeoverVoteCast">;
}) {
  const { token, proposalId, voteRef } = event.args;
  if (await context.db.find(takeoverVote, { voteRef })) return;
  await context.db
    .insert(takeoverVote)
    .values({ voteRef, token, proposalId, castAt: event.block.timestamp });
  const p = await context.db.find(takeoverProposal, { proposalId });
  if (p) {
    await context.db
      .update(takeoverProposal, { proposalId })
      .set({ ballotCount: p.ballotCount + 1 });
  }
}

async function patch(
  context: { db: Context["db"] },
  proposalId: bigint,
  values: Partial<typeof takeoverProposal.$inferInsert>,
) {
  if (!(await context.db.find(takeoverProposal, { proposalId }))) return;
  await context.db.update(takeoverProposal, { proposalId }).set(values);
}

export async function onTakeoverClosed({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverClosed">;
  context: Context<"TakeoverGovernor:TakeoverClosed">;
}) {
  await patch(context, event.args.proposalId, { closed: true, closedAt: event.block.timestamp });
}

export async function onTakeoverTallied({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverTallied">;
  context: Context<"TakeoverGovernor:TakeoverTallied">;
}) {
  const { proposalId, forWeight, againstWeight } = event.args;
  await patch(context, proposalId, {
    forWeight,
    againstWeight,
    tallied: true,
    talliedAt: event.block.timestamp,
  });
}

export async function onTakeoverExecuted({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverExecuted">;
  context: Context<"TakeoverGovernor:TakeoverExecuted">;
}) {
  await patch(context, event.args.proposalId, {
    executed: true,
    executedAt: event.block.timestamp,
  });
}

export async function onTakeoverCanceled({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverCanceled">;
  context: Context<"TakeoverGovernor:TakeoverCanceled">;
}) {
  await patch(context, event.args.proposalId, {
    canceled: true,
    canceledAt: event.block.timestamp,
  });
}
