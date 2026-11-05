import type { Hex } from "viem";
import type { EpochClock, ShortlistSchedule } from "./types";

/** Current epoch index at unix time `now`, or null without a clock (or before epoch 0). */
export function currentEpochAt(clock: EpochClock | null, now: bigint): bigint | null {
  if (!clock || now < clock.epochZeroStart) return null;
  return (now - clock.epochZeroStart) / clock.epochLength;
}

/**
 * Splits a stored schedule into the list in effect for `current` and the pending one. A pending
 * list may be empty (a token returning to the default). Without a clock a scheduled list is
 * reported as pending, which is what it is unless it was applied immediately.
 */
export function resolveSchedule(
  s: ShortlistSchedule | null,
  current: bigint | null,
): { inEffect: Hex[]; pending: { causeIds: Hex[]; effectiveFrom: bigint } | null } {
  if (!s) return { inEffect: [], pending: null };
  if (s.effectiveFrom === null) return { inEffect: s.causeIds, pending: null };
  if (current !== null && current >= s.effectiveFrom) return { inEffect: s.causeIds, pending: null };
  return {
    inEffect: s.previousCauseIds,
    pending: { causeIds: s.causeIds, effectiveFrom: s.effectiveFrom },
  };
}
