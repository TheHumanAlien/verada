import type { StampStatus, SwarmClient } from "../swarm.js";
import type { Job, Log } from "./types.js";

export const MIN_TTL_SECONDS = 30 * 86_400;
export const MAX_UTILIZATION = 0.7;

/** Reasons a postage batch needs attention (top up, dilute or replace). Empty when healthy. */
export function stampWarnings(s: StampStatus): string[] {
  const w: string[] = [];
  if (!s.usable) w.push("batch not usable");
  if (s.batchTTL >= 0 && s.batchTTL < MIN_TTL_SECONDS) w.push(`TTL ${Math.floor(s.batchTTL / 86_400)} days is under 30 days`);
  if (s.utilizationRatio > MAX_UTILIZATION) w.push(`utilization ${(s.utilizationRatio * 100).toFixed(1)}% is over 70%`);
  return w;
}

/** Logs a warning (alarmable via the log group) when the postage batch runs low. */
export function createStampWatchJob(deps: { swarm: SwarmClient; intervalMs: number; log: Log }): Job {
  return {
    name: "stamp-watch",
    intervalMs: deps.intervalMs,
    async run() {
      const s = await deps.swarm.stamp();
      const warnings = stampWarnings(s);
      const data = {
        ttlDays: s.batchTTL >= 0 ? Math.floor(s.batchTTL / 86_400) : null,
        utilizationRatio: Number(s.utilizationRatio.toFixed(4)),
        usable: s.usable,
      };
      if (warnings.length > 0) deps.log("warn", "postage batch needs attention", { ...data, warnings });
      else deps.log("info", "postage batch ok", data);
    },
  };
}
