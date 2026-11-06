import { zeroAddress, type Address } from "viem";
import { sameAddress, TERMINAL_PROPOSAL_STATES, type EpochView, type KeeperAction, type ProposalView, type Tally } from "./chain.js";

/** What to do next for one epoch or proposal, decided from chain state alone. */
export type Step =
  | { type: "none"; reason: string; terminal: boolean }
  | { type: "send"; action: KeeperAction }
  | { type: "decrypt"; scheme: Address; governor: Address; token: Address; scope: bigint };

const none = (reason: string, terminal = false): Step => ({ type: "none", reason, terminal });

/** Finalizing an epoch with ballots needs its options (org ids) as calldata. */
export const finalizeNeedsOptions = (v: EpochView) => v.opened && v.voterCount > 0n;

/** The tally is only needed once the poll has ballots and is closed. */
export const epochNeedsTally = (v: EpochView) => v.opened && v.closed && v.voterCount > 0n && !v.finalized;

/**
 * Next step for an ended epoch (`epoch < currentEpoch`) of a registered token.
 *
 * - finalized: nothing, ever again.
 * - never opened, or opened without ballots: `finalizeEpoch` (the default cause wins; reverts
 *   `NoVotes` while none is set). Such an epoch is never closed, which saves a public decryption.
 * - opened with ballots, not closed: `closeEpoch` (makes the tallies publicly decryptable).
 * - closed, tally not final: decrypt the tally and `submitTally`, if the epoch's scheme is the
 *   configured Zama scheme.
 * - closed, tally final: `finalizeEpoch`. Its `orgIds` are left empty here: the caller fills them
 *   from the ballot's `BallotPrepared` log ({@link finalizeNeedsOptions}).
 */
export function planEpoch(
  token: Address,
  epoch: bigint,
  v: EpochView,
  tally: Tally | undefined,
  ctx: { epochGovernor: Address; zamaScheme: Address },
): Step {
  if (v.finalized) return none("finalized", true);
  if (!v.opened || v.voterCount === 0n) return { type: "send", action: { kind: "finalizeEpoch", token, epoch, orgIds: [] } };
  if (!v.closed) return { type: "send", action: { kind: "closeEpoch", token, epoch } };
  if (!tally) return none("tally not read");
  if (tally.isFinal) return { type: "send", action: { kind: "finalizeEpoch", token, epoch, orgIds: [] } };
  if (v.scheme === zeroAddress || !sameAddress(v.scheme, ctx.zamaScheme)) return none("epoch scheme is not the Zama scheme");
  return { type: "decrypt", scheme: v.scheme, governor: ctx.epochGovernor, token, scope: epoch };
}

export const proposalNeedsTally = (p: ProposalView) => p.state === "Closing" && p.closed && !p.tallied;

/**
 * Next step for a takeover proposal.
 *
 * - Closing, not closed: `closeProposal`.
 * - Closing, closed, scheme tally not final: decrypt and `submitTally(takeoverGovernor, token, id)`.
 * - Closing, closed, scheme tally final (so not yet tallied): `recordTally`.
 * - Succeeded: `execute`.
 * - Active: wait. Defeated, Executed, Canceled, Expired: nothing, ever again.
 */
export function planProposal(
  id: bigint,
  p: ProposalView,
  tally: Tally | undefined,
  ctx: { takeoverGovernor: Address; zamaScheme: Address },
): Step {
  if (TERMINAL_PROPOSAL_STATES.includes(p.state)) return none(p.state, true);
  if (p.state === "Succeeded") return { type: "send", action: { kind: "execute", id } };
  if (p.state !== "Closing") return none(p.state);
  if (!p.closed) return { type: "send", action: { kind: "closeProposal", id } };
  if (p.tallied) return none("tallied");
  if (!tally) return none("tally not read");
  if (tally.isFinal) return { type: "send", action: { kind: "recordTally", id } };
  if (p.scheme === zeroAddress || !sameAddress(p.scheme, ctx.zamaScheme)) return none("proposal scheme is not the Zama scheme");
  return { type: "decrypt", scheme: p.scheme, governor: ctx.takeoverGovernor, token: p.token, scope: id };
}
