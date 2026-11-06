/**
 * "Open this week's ballot": the platform keeper leaves idle tokens' epochs closed, so a voter who
 * finds one unopened can open it themselves. The plan is the SDK's `planBallotOpening`, the same
 * code the keeper runs, over the app's chain client and indexer; the indexer's catalogue entries
 * and pick proofs are checked against the roots on chain, and the governor checks every proof
 * again, so a wrong indexer can only make the transaction fail.
 */
import { ballotCall, createBallotReader, CuratedPicksUnavailable, planBallotOpening, type BallotStep } from "@verada/sdk";
import type { Abi, Address } from "viem";
import type { DataDeps } from "./data";

export async function planOpening(deps: DataDeps, governor: Address, token: Address, epoch: bigint): Promise<BallotStep> {
  return planBallotOpening(
    {
      reader: createBallotReader(deps.chain(), governor),
      entries: { entries: (at) => deps.indexer.catalogEntries(at) },
      picks: { picks: (label, e, region) => deps.indexer.agentPicks(label, e, region) },
    },
    token,
    epoch,
  );
}

/** The wagmi `writeContract` request for a planned opening, or null when nothing is to be sent. */
export function openingRequest(step: BallotStep, governor: Address, chainId: number): { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; chainId: number } | null {
  if (step.type !== "send") return null;
  return { ...ballotCall(step.action, governor), chainId };
}

/** Plain-language reason a ballot cannot be opened yet. */
export function openingErrorText(e: unknown): string {
  if (e instanceof CuratedPicksUnavailable) {
    const when = e.retryAt ? ` after ${new Date(e.retryAt).toISOString().replace(".000Z", "Z")}` : " later";
    return `A curator agent's picks for this ballot are not published yet. Try again${when}, when the ballot can be filled in rotation.`;
  }
  if (e instanceof Error && e.name === "CatalogMismatch") return "The indexer's catalogue does not match the chain, so the ballot cannot be built right now.";
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}
