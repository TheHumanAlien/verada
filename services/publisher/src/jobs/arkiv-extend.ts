import { expiringKeys, type ArkivRegistry } from "@verada/arkiv-registry";
import { RENEW_BEFORE_BLOCKS, type Job, type Log } from "./types.js";

/**
 * Extends every platform entity (cores, profiles, causes) expiring within 30 days to the maximum
 * lifetime, including ones no longer listed by the indexer.
 */
export function createArkivExtendJob(deps: {
  registry: ArkivRegistry;
  intervalMs: number;
  log: Log;
  renewBeforeBlocks?: bigint;
}): Job {
  return {
    name: "arkiv-extend",
    intervalMs: deps.intervalMs,
    async run() {
      const [cores, profiles, causes, currentBlock] = await Promise.all([
        deps.registry.listCores(),
        deps.registry.listProfiles(),
        deps.registry.listCauses(),
        deps.registry.currentBlock(),
      ]);
      const keys = expiringKeys([...cores, ...profiles, ...causes], currentBlock, deps.renewBeforeBlocks ?? RENEW_BEFORE_BLOCKS);
      if (keys.length === 0) return;
      try {
        const r = await deps.registry.extendExpiring(keys);
        deps.log("info", "arkiv entities extended", { count: keys.length, dryRun: r.dryRun });
      } catch (err) {
        deps.log("error", "arkiv extend failed", {
          count: keys.length,
          error: deps.registry.redact(err instanceof Error ? err.message : String(err)).slice(0, 500),
        });
      }
    },
  };
}
