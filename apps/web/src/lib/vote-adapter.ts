import { isAddress, isHex, keccak256, toHex, type Address, type Hex } from "viem";
import { governorAbi } from "./abis";

export interface VoteRequest {
  token: Address;
  causeId: Hex;
}

export interface CastVoteCall {
  functionName: "castVote";
  args: readonly [Address, Hex, Hex];
}

/**
 * Seam between the UI and the on-chain vote verifier. A private voting scheme
 * implements this interface (producing its own proof) and is registered in
 * `voteAdapters`; the UI does not change.
 */
export interface VoteAdapter {
  id: string;
  label: string;
  /** True while the adapter is a stand-in that provides no vote privacy. */
  placeholder: boolean;
  buildCall(request: VoteRequest): Promise<CastVoteCall>;
}

/** PLACEHOLDER: sends an empty proof. Offers no privacy; for wiring and tests only. */
export const publicPlaceholderAdapter: VoteAdapter = {
  id: "public-placeholder",
  label: "Public vote (placeholder, not private)",
  placeholder: true,
  async buildCall({ token, causeId }) {
    return { functionName: "castVote", args: [token, causeId, "0x"] };
  },
};

export const voteAdapters: readonly VoteAdapter[] = [publicPlaceholderAdapter];
export const defaultVoteAdapter: VoteAdapter = publicPlaceholderAdapter;

export const governorContract = { abi: governorAbi } as const;

/** A cause id is either a bytes32 hex string or a plain org identifier hashed with keccak256. */
export function toCauseId(input: string): Hex | null {
  const value = input.trim();
  if (value === "") return null;
  if (isHex(value) && value.length === 66) return value;
  return keccak256(toHex(value));
}

export function parseVoteRequest(tokenInput: string, causeInput: string): VoteRequest | string {
  const token = tokenInput.trim();
  if (!isAddress(token)) return "Token must be a valid address";
  const causeId = toCauseId(causeInput);
  if (!causeId) return "Cause is required";
  return { token, causeId };
}
