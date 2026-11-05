import type { TakeoverRow } from "./types";

/** `ITakeoverGovernor.State` without `None` (unknown proposals are a 404). */
export type TakeoverState =
  | "Active"
  | "Closing"
  | "Defeated"
  | "Succeeded"
  | "Executed"
  | "Canceled"
  | "Expired"
  | "Superseded";

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
  | "generation"
>;

/**
 * Mirrors `TakeoverGovernor.state` from the indexed fields at unix time `now` (seconds), where
 * `executions` is the number of executed takeovers of the token. A pending proposal (Active,
 * Closing or Succeeded) created before another proposal of the token executed is `Superseded`.
 * An unknown execution deadline (both reads failed at indexing time) never yields `Expired`.
 */
export function takeoverState(p: StateInput, now: bigint, executions: number): TakeoverState {
  if (p.canceled) return "Canceled";
  if (p.executed) return "Executed";
  const expired = p.executionDeadline !== null && now > p.executionDeadline;
  let s: TakeoverState;
  if (p.tallied) {
    const passed = p.forWeight >= p.quorumWeight && p.forWeight > p.againstWeight;
    if (!passed) return "Defeated";
    if (expired) return "Expired";
    s = "Succeeded";
  } else if (now <= p.end && !p.closed) {
    s = "Active";
  } else if (expired) {
    return "Expired";
  } else {
    s = "Closing";
  }
  return p.generation !== executions ? "Superseded" : s;
}

/** Public shape of a proposal. */
export function toProposal(p: TakeoverRow, now: bigint, executions: number) {
  return {
    proposalId: p.proposalId,
    token: p.token,
    proposer: p.proposer,
    newController: p.newController,
    start: p.start,
    end: p.end,
    executionDeadline: p.executionDeadline,
    snapshot: p.snapshot,
    lookbackSnapshot: p.lookbackSnapshot,
    circulatingWeight: p.circulatingWeight,
    quorumWeight: p.quorumWeight,
    forWeight: p.forWeight,
    againstWeight: p.againstWeight,
    closed: p.closed,
    tallied: p.tallied,
    executed: p.executed,
    canceled: p.canceled,
    ballotCount: p.ballotCount,
    state: takeoverState(p, now, executions),
    createdAt: p.createdAt,
    txHash: p.txHash,
  };
}
