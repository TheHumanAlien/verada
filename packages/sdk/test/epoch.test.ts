import { describe, expect, it } from "vitest";
import {
  EPOCH_LENGTH,
  alignToThursday,
  epochAt,
  epochEnd,
  epochStart,
  epochZeroStart,
  isEpochEnded,
  secondsRemaining,
} from "../src/epoch.js";

// 2024-01-04T00:00:00Z was a Thursday.
const THURSDAY = BigInt(Date.UTC(2024, 0, 4) / 1000);

describe("epoch math", () => {
  it("aligns to Thursday 00:00 UTC", () => {
    const aligned = alignToThursday(THURSDAY + 3n * 86_400n + 12_345n);
    expect(aligned).toBe(THURSDAY);
    expect(new Date(Number(aligned) * 1000).getUTCDay()).toBe(4);
    expect(aligned % 86_400n).toBe(0n);
  });

  it("leaves an aligned timestamp unchanged", () => {
    expect(alignToThursday(THURSDAY)).toBe(THURSDAY);
    expect(epochZeroStart(THURSDAY)).toBe(THURSDAY);
  });

  it("computes epoch index and boundaries", () => {
    const z = THURSDAY;
    expect(epochAt(z, z)).toBe(0n);
    expect(epochAt(z + EPOCH_LENGTH - 1n, z)).toBe(0n);
    expect(epochAt(z + EPOCH_LENGTH, z)).toBe(1n);
    expect(epochStart(3n, z)).toBe(z + 3n * EPOCH_LENGTH);
    expect(epochEnd(3n, z)).toBe(z + 4n * EPOCH_LENGTH);
  });

  it("tracks epoch end and remaining time", () => {
    const z = THURSDAY;
    expect(isEpochEnded(0n, z, z + EPOCH_LENGTH - 1n)).toBe(false);
    expect(isEpochEnded(0n, z, z + EPOCH_LENGTH)).toBe(true);
    expect(secondsRemaining(z + 100n, z)).toBe(EPOCH_LENGTH - 100n);
  });

  it("rejects timestamps before epoch zero", () => {
    expect(() => epochAt(THURSDAY - 1n, THURSDAY)).toThrow(RangeError);
  });
});
