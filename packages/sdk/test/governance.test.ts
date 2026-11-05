import { describe, expect, it } from "vitest";
import { EPOCH_LENGTH, epochStart } from "../src/epoch.js";
import {
  MAX_BALLOT_OPTIONS,
  WEIGHT_UNIT,
  argmax,
  bpsOfSupply,
  decodeFheBallot,
  encodeFheBallot,
  encodePlainBallot,
  epochSnapshot,
  epochVotingEnd,
  takeoverSucceeded,
  toWeightWhole,
} from "../src/governance.js";

const ZERO = 1_700_000_000n;

describe("weights and snapshots", () => {
  it("counts whole tokens", () => {
    expect(toWeightWhole(0n)).toBe(0n);
    expect(toWeightWhole(WEIGHT_UNIT - 1n)).toBe(0n);
    expect(toWeightWhole(5n * WEIGHT_UNIT + 1n)).toBe(5n);
    expect(toWeightWhole(100_000_000_000n * WEIGHT_UNIT)).toBe(100_000_000_000n);
    expect(() => toWeightWhole(-1n)).toThrow(RangeError);
  });

  it("snapshot is one second before the epoch start", () => {
    expect(epochSnapshot(3n, ZERO)).toBe(epochStart(3n, ZERO) - 1n);
    expect(epochVotingEnd(3n, ZERO)).toBe(epochStart(3n, ZERO) + EPOCH_LENGTH);
  });
});

describe("ballots", () => {
  it("encodes and decodes FHE ballots", () => {
    const handle = `0x${"ab".repeat(32)}` as const;
    const proof = "0x0102030405" as const;
    const ballot = encodeFheBallot(handle, proof);
    expect(decodeFheBallot(ballot)).toEqual({ handle, inputProof: proof });
    expect(() => encodeFheBallot("0x1234", proof)).toThrow(/32 bytes/);
  });

  it("encodes plaintext ballots for the mock scheme", () => {
    expect(encodePlainBallot(3)).toBe(`0x${"0".repeat(63)}3`);
    expect(() => encodePlainBallot(MAX_BALLOT_OPTIONS)).toThrow(RangeError);
    expect(() => encodePlainBallot(-1)).toThrow(RangeError);
  });
});

describe("outcomes", () => {
  it("argmax picks the lowest index on ties", () => {
    expect(argmax([1n, 3n, 3n])).toBe(1);
    expect(argmax([0n, 0n])).toBe(0);
    expect(argmax([])).toBe(-1);
  });

  it("takeover needs quorum and a strict majority", () => {
    expect(takeoverSucceeded({ forWeight: 10n, againstWeight: 9n, quorumWeight: 10n })).toBe(true);
    expect(takeoverSucceeded({ forWeight: 9n, againstWeight: 1n, quorumWeight: 10n })).toBe(false);
    expect(takeoverSucceeded({ forWeight: 10n, againstWeight: 10n, quorumWeight: 10n })).toBe(false);
  });

  it("bps of supply rounds down", () => {
    expect(bpsOfSupply(100_000_000_000n, 300)).toBe(3_000_000_000n);
    expect(bpsOfSupply(3n, 2500)).toBe(0n);
    expect(() => bpsOfSupply(1n, 10_001)).toThrow(RangeError);
  });
});

describe("packed tallies", () => {
  it("counts words and unpacks three 40-bit counters per word", async () => {
    const { tallyWordCount, unpackTallyWords, MAX_BALLOT_OPTIONS } = await import("../src/governance.js");
    expect(MAX_BALLOT_OPTIONS).toBe(32);
    expect(tallyWordCount(2)).toBe(1);
    expect(tallyWordCount(32)).toBe(11);
    const max = (1n << 40n) - 1n;
    const words = [5n | (7n << 40n) | (max << 80n), 9n];
    expect(unpackTallyWords(words, 4)).toEqual([5n, 7n, max, 9n]);
    expect(() => unpackTallyWords([1n], 4)).toThrow(RangeError);
  });
});
