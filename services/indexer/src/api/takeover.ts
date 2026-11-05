import type { TakeoverRow } from "./types";

/** `ITakeoverGovernor.State` without `None` (unknown proposals are a 404). */
export type TakeoverState =
  | "Active"
  | "Closing"
  | "Defeated"
  | "Succeeded"
  | "Executed"
  | "Canceled"
  | "Expired";

type StateInput = Pick<
  TakeoverRow,
  | "end"
  | "executionDeadline"
  | "quorumWeight"
  | "forWeight"
  | "againstWeight"
  | "closed"
  | "tallied"
  | "executed"
  | "canceled"
>;

/**
 * Mirrors `TakeoverGovernor.state` from the indexed fields at unix time `now` (seconds). An
 * unknown execution deadline (both reads failed at indexing time) never yields `Expired`.
 */
export function takeoverState(p: StateInput, now: bigint): TakeoverState {
  if (p.canceled) return "Canceled";
  if (p.executed) return "Executed";
  const expired = p.executionDeadline !== null && now > p.executionDeadline;
  if (p.tallied) {
    const passed = p.forWeight >= p.quorumWeight && p.forWeight > p.againstWeight;
    if (!passed) return "Defeated";
    return expired ? "Expired" : "Succeeded";
  }
  if (now <= p.end && !p.closed) return "Active";
  return expired ? "Expired" : "Closing";
}

/** Public shape of a proposal. */
export function toProposal(p: TakeoverRow, now: bigint) {
  return {
    proposalId: p.proposalId,
    token: p.token,
    proposer: p.proposer,
    newController: p.newController,
    start: p.start,
    end: p.end,
    executionDeadline: p.executionDeadline,
    snapshot: p.snapshot,
    quorumWeight: p.quorumWeight,
    forWeight: p.forWeight,
    againstWeight: p.againstWeight,
    closed: p.closed,
    tallied: p.tallied,
    executed: p.executed,
    canceled: p.canceled,
    ballotCount: p.ballotCount,
    state: takeoverState(p, now),
    createdAt: p.createdAt,
    txHash: p.txHash,
  };
}
