import type { Context, Event } from "ponder:registry";
import { ballot, poll } from "ponder:schema";

type Hex = `0x${string}`;

const key = (a: { governor: Hex; token: Hex; scope: bigint }) => ({
  governor: a.governor,
  token: a.token,
  scope: a.scope,
});

export async function onPollOpened({
  event,
  context,
}: {
  event: Event<"ZamaVotingScheme:PollOpened">;
  context: Context<"ZamaVotingScheme:PollOpened">;
}) {
  const { optionCount } = event.args;
  await context.db
    .insert(poll)
    .values({
      ...key(event.args),
      scheme: event.log.address,
      optionCount,
      opened: true,
      closed: false,
      isFinal: false,
      ballotCount: 0,
      counts: null,
      openedAt: event.block.timestamp,
      closedAt: null,
      finalAt: null,
    })
    .onConflictDoNothing();
}

export async function onBallotCast({
  event,
  context,
}: {
  event: Event<"ZamaVotingScheme:BallotCast">;
  context: Context<"ZamaVotingScheme:BallotCast">;
}) {
  const { voter, weight, ballotRef } = event.args;
  const k = key(event.args);
  if (await context.db.find(ballot, { ballotRef })) return;
  await context.db.insert(ballot).values({
    ...k,
    ballotRef,
    voter,
    weight,
    castAt: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  const row = await context.db.find(poll, k);
  if (row) await context.db.update(poll, k).set({ ballotCount: row.ballotCount + 1 });
}

export async function onTallyRequested({
  event,
  context,
}: {
  event: Event<"ZamaVotingScheme:TallyRequested">;
  context: Context<"ZamaVotingScheme:TallyRequested">;
}) {
  const k = key(event.args);
  if (!(await context.db.find(poll, k))) return;
  await context.db.update(poll, k).set({ closed: true, closedAt: event.block.timestamp });
}

export async function onTallySubmitted({
  event,
  context,
}: {
  event: Event<"ZamaVotingScheme:TallySubmitted">;
  context: Context<"ZamaVotingScheme:TallySubmitted">;
}) {
  const k = key(event.args);
  if (!(await context.db.find(poll, k))) return;
  await context.db.update(poll, k).set({
    isFinal: true,
    counts: [...event.args.counts],
    finalAt: event.block.timestamp,
  });
}
