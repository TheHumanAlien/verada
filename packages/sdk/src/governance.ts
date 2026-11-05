import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { EPOCH_LENGTH, epochStart } from "./epoch.js";

/** Largest number of options a poll may have (`IVotingScheme.MAX_OPTIONS`). */
export const MAX_BALLOT_OPTIONS = 32;

/** Largest number of causes a token's controller may pin (`EpochGovernor.PINNED_MAX`). */
export const PINNED_MAX = 8;

/** Packed tally layout of `ZamaVotingScheme`: 40-bit counters, three per `euint128` word. */
export const TALLY_COUNTER_BITS = 40n;
export const TALLY_COUNTERS_PER_WORD = 3;

/** Number of packed tally words (decryption handles) of a poll with `optionCount` options. */
export function tallyWordCount(optionCount: number): number {
  return Math.ceil(optionCount / TALLY_COUNTERS_PER_WORD);
}

/** Per-option counts from decrypted packed tally words, as `ZamaVotingScheme.submitTally` unpacks. */
export function unpackTallyWords(words: readonly bigint[], optionCount: number): bigint[] {
  const mask = (1n << TALLY_COUNTER_BITS) - 1n;
  return Array.from({ length: optionCount }, (_, i) => {
    const word = words[Math.floor(i / TALLY_COUNTERS_PER_WORD)];
    if (word === undefined) throw new RangeError(`missing tally word for option ${i}`);
    return (word >> (TALLY_COUNTER_BITS * BigInt(i % TALLY_COUNTERS_PER_WORD))) & mask;
  });
}

/** Voting weight is counted in whole tokens so that per-option totals fit in 64 bits. */
export const WEIGHT_UNIT = 10n ** 18n;

/** Takeover poll option indices. */
export const TAKEOVER_AGAINST = 0;
export const TAKEOVER_FOR = 1;

/** Converts raw vote units (18 decimals) to the whole-token weight the governors use. */
export function toWeightWhole(votes: bigint): bigint {
  if (votes < 0n) throw new RangeError("votes must be non-negative");
  return votes / WEIGHT_UNIT;
}

/**
 * Snapshot timepoint of an epoch: one second before it starts, so `getPastVotes` is always a
 * strictly past lookup, even for a ballot cast in the epoch's first second. A token's launch
 * epoch is the exception: its snapshot is set at registration (`LaunchSnapshotSet`), so read
 * `EpochGovernor.snapshotFor(token, epoch)` when the launch epoch matters.
 */
export function epochSnapshot(epoch: bigint, zeroStart: bigint): bigint {
  return epochStart(epoch, zeroStart) - 1n;
}

/** End of the epoch's voting window (exclusive): the start of the next epoch. */
export function epochVotingEnd(epoch: bigint, zeroStart: bigint): bigint {
  return epochStart(epoch, zeroStart) + EPOCH_LENGTH;
}

/**
 * Encodes a Zama FHE ballot: the external encrypted-input handle for the chosen option index
 * and the input proof produced by the relayer SDK for `(scheme address, voter address)`.
 */
export function encodeFheBallot(handle: Hex, inputProof: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(handle)) throw new Error("handle must be 32 bytes");
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [handle, inputProof]);
}

/** Decodes a ballot produced by {@link encodeFheBallot}. */
export function decodeFheBallot(ballot: Hex): { handle: Hex; inputProof: Hex } {
  const [handle, inputProof] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }],
    ballot,
  );
  return { handle, inputProof };
}

/** Plaintext ballot encoding used by the test-only mock scheme: `abi.encode(uint8 choice)`. */
export function encodePlainBallot(choice: number): Hex {
  assertOption(choice);
  return encodeAbiParameters([{ type: "uint8" }], [choice]);
}

export function assertOption(choice: number): void {
  if (!Number.isInteger(choice) || choice < 0 || choice >= MAX_BALLOT_OPTIONS) {
    throw new RangeError(`option index must be in [0, ${MAX_BALLOT_OPTIONS})`);
  }
}

/** Index of the largest count; ties go to the lowest index. Returns -1 for an empty tally. */
export function argmax(counts: readonly bigint[]): number {
  let best = -1;
  let bestCount = -1n;
  counts.forEach((count, i) => {
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
  });
  return best;
}

export interface TakeoverTally {
  forWeight: bigint;
  againstWeight: bigint;
  quorumWeight: bigint;
}

/** Mirrors `TakeoverGovernor`: FOR must reach the quorum and strictly beat AGAINST. */
export function takeoverSucceeded(t: TakeoverTally): boolean {
  return t.forWeight >= t.quorumWeight && t.forWeight > t.againstWeight;
}

/** `supplyWhole * bps / 10_000`, rounded down, as the governor computes quorum and threshold. */
export function bpsOfSupply(supplyWhole: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("bps out of range");
  return (supplyWhole * BigInt(bps)) / 10_000n;
}
