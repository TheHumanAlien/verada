/** Epoch length in seconds (7 days). */
export const EPOCH_LENGTH = 604_800n;

/**
 * Unix time 0 is Thursday 00:00 UTC, so any multiple of one week since the
 * unix epoch starts on a Thursday at 00:00 UTC.
 */
export function alignToThursday(timestamp: bigint): bigint {
  if (timestamp < 0n) throw new RangeError("timestamp must be non-negative");
  return timestamp - (timestamp % EPOCH_LENGTH);
}

/** Start time of epoch zero for a factory deployed at `deployTimestamp`. */
export function epochZeroStart(deployTimestamp: bigint): bigint {
  return alignToThursday(deployTimestamp);
}

/** Epoch index containing `timestamp`; throws if it precedes epoch zero. */
export function epochAt(timestamp: bigint, zeroStart: bigint): bigint {
  if (timestamp < zeroStart) throw new RangeError("timestamp precedes epoch zero");
  return (timestamp - zeroStart) / EPOCH_LENGTH;
}

export function epochStart(epoch: bigint, zeroStart: bigint): bigint {
  if (epoch < 0n) throw new RangeError("epoch must be non-negative");
  return zeroStart + epoch * EPOCH_LENGTH;
}

/** Exclusive end time of the epoch. */
export function epochEnd(epoch: bigint, zeroStart: bigint): bigint {
  return epochStart(epoch, zeroStart) + EPOCH_LENGTH;
}

/** Whether the epoch has ended and can be finalized at `timestamp`. */
export function isEpochEnded(epoch: bigint, zeroStart: bigint, timestamp: bigint): boolean {
  return timestamp >= epochEnd(epoch, zeroStart);
}

/** Seconds left in the epoch containing `timestamp`. */
export function secondsRemaining(timestamp: bigint, zeroStart: bigint): bigint {
  const epoch = epochAt(timestamp, zeroStart);
  return epochEnd(epoch, zeroStart) - timestamp;
}
