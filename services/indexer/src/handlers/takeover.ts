import type { Context, Event } from "ponder:registry";
import { takeoverProposal, takeoverToken, takeoverVote } from "ponder:schema";

interface ProposalReads {
  executionDeadline: bigint | null;
  lookbackSnapshot: bigint | null;
  circulatingWeight: bigint | null;
}

/**
 * The event omits the execution deadline, lookback snapshot and circulating weight. They are
 * read from `getProposal` at the proposal block (exact: parameters are captured per proposal);
 * if that fails the deadline is derived from `params().executionWindow` at that block, else all
 * stay null (the API then never reports `Expired`).
 */
async function readProposal(
  event: Event<"TakeoverGovernor:TakeoverProposed">,
  context: Context<"TakeoverGovernor:TakeoverProposed">,
): Promise<ProposalReads> {
  const abi = context.contracts.TakeoverGovernor.abi;
  const address = event.log.address;
  try {
    const p = await context.client.readContract({
      abi,
      address,
      functionName: "getProposal",
      args: [event.args.proposalId],
    });
    return {
      executionDeadline: BigInt(p.executionDeadline),
      lookbackSnapshot: BigInt(p.lookbackSnapshot),
      circulatingWeight: BigInt(p.circulatingWeight),
    };
  } catch {
    const none = { lookbackSnapshot: null, circulatingWeight: null };
    try {
      const params = await context.client.readContract({ abi, address, functionName: "params" });
      return { ...none, executionDeadline: BigInt(event.args.end) + BigInt(params.executionWindow) };
    } catch {
      return { ...none, executionDeadline: null };
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
  const reads = await readProposal(event, context);
  const generation = (await context.db.find(takeoverToken, { token }))?.executions ?? 0;
  await context.db.insert(takeoverProposal).values({
    proposalId,
    token,
    proposer,
    newController,
    start: BigInt(start),
    end: BigInt(end),
    // Weights are read one second before the proposal was created.
    snapshot: BigInt(start) - 1n,
    ...reads,
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
    generation,
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

/**
 * Emitted with every execution: every other pending proposal of the token created before it is
 * now `Superseded`. The API derives that lazily by comparing generations.
 */
export async function onTakeoverSuperseded({
  event,
  context,
}: {
  event: Event<"TakeoverGovernor:TakeoverSuperseded">;
  context: Context<"TakeoverGovernor:TakeoverSuperseded">;
}) {
  const { token, executedProposalId } = event.args;
  const row = await context.db.find(takeoverToken, { token });
  if (row) {
    await context.db
      .update(takeoverToken, { token })
      .set({ executions: row.executions + 1, lastExecutedProposalId: executedProposalId });
  } else {
    await context.db
      .insert(takeoverToken)
      .values({ token, executions: 1, lastExecutedProposalId: executedProposalId });
  }
}
