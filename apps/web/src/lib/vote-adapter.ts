import { encodePlainBallot, assertOption } from "@verada/sdk";
import { zamaVotingSchemeAbi } from "@verada/sdk/abis";
import { isHex, keccak256, toHex, type Address, type Hex } from "viem";
import { buildFheBallot, type Encryptor } from "./ballot";

/** One ballot: an option index for a governor's poll (`scope` is the epoch or the proposal id). */
export interface BallotRequest {
  /** Voting scheme the ballot is sent to (and the encrypted input is bound to). */
  scheme: Address;
  governor: Address;
  token: Address;
  scope: bigint;
  choice: number;
  /** The voter. Encrypted inputs are bound to them, so they must send the transaction themselves. */
  voter: Address;
}

/** `IVotingScheme.castBallot(governor, token, scope, ballot)`, sent by the voter to the scheme. */
export interface CastBallotCall {
  functionName: "castBallot";
  args: readonly [Address, Address, bigint, Hex];
}

/**
 * Seam between the UI and the voting scheme. An adapter turns a choice into ballot bytes; the UI
 * always sends the same `castBallot` call to the scheme.
 */
export interface VoteAdapter {
  id: string;
  label: string;
  /** True when the choice is hidden on-chain. */
  private: boolean;
  /** True while the adapter is a stand-in that provides no vote privacy. */
  placeholder: boolean;
  buildCall(request: BallotRequest): Promise<CastBallotCall>;
}

function call(r: BallotRequest, ballot: Hex): CastBallotCall {
  return { functionName: "castBallot", args: [r.governor, r.token, r.scope, ballot] };
}

/** Zama FHE ballots: the option index is encrypted for `(scheme, voter)` before it leaves the browser. */
export function zamaVoteAdapter(getEncryptor: () => Promise<Encryptor>): VoteAdapter {
  return {
    id: "zama-fhe",
    label: "Encrypted ballot (Zama FHE)",
    private: true,
    placeholder: false,
    async buildCall(r) {
      assertOption(r.choice);
      const ballot = await buildFheBallot(await getEncryptor(), {
        contractAddress: r.scheme,
        userAddress: r.voter,
        choice: r.choice,
      });
      return call(r, ballot);
    },
  };
}

/** DEVELOPMENT ONLY: plaintext ballots (`abi.encode(uint8)`) for the mock scheme. No privacy. */
export const plainVoteAdapter: VoteAdapter = {
  id: "dev-plain",
  label: "Plaintext ballot (development mock scheme, NOT private)",
  private: false,
  placeholder: true,
  async buildCall(r) {
    return call(r, encodePlainBallot(r.choice));
  },
};

/** The adapter for this build: plaintext only when `devPlainBallots` was set at build time. */
export function selectVoteAdapter(cfg: { devPlainBallots: boolean }, getEncryptor: () => Promise<Encryptor>): VoteAdapter {
  return cfg.devPlainBallots ? plainVoteAdapter : zamaVoteAdapter(getEncryptor);
}

export const schemeContract = { abi: zamaVotingSchemeAbi } as const;

/** A cause id is either a bytes32 hex string or a plain org identifier hashed with keccak256. */
export function toCauseId(input: string): Hex | null {
  const value = input.trim();
  if (value === "") return null;
  if (isHex(value) && value.length === 66) return value;
  return keccak256(toHex(value));
}

/** Parses a user-typed option index (0-based). */
export function parseChoice(input: string, optionCount: number): number | string {
  const n = Number(input);
  if (input.trim() === "" || !Number.isInteger(n)) return "Choose an option";
  if (n < 0 || n >= optionCount) return `Option must be between 0 and ${optionCount - 1}`;
  return n;
}
