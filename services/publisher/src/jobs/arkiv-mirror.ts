import { applyPlan, planReconcile, type ArkivRegistry, type RegistryLogger } from "@verada/arkiv-registry";
import type { IndexerClient } from "../indexer-client.js";
import { RENEW_BEFORE_BLOCKS, type Job, type Log } from "./types.js";

export interface ArkivMirrorDeps {
  indexer: IndexerClient;
  registry: ArkivRegistry;
  chainId: number;
  intervalMs: number;
  log: Log;
  renewBeforeBlocks?: bigint;
  maxCreates?: number;
}

export const registryLogger = (log: Log): RegistryLogger => ({
  info: (m, d) => log("info", m, d),
  warn: (m, d) => log("warn", m, d),
  error: (m, d) => log("error", m, d),
});

/** Mirrors indexer tokens and causes onto Arkiv: read both sides, plan, apply. */
export function createArkivMirrorJob(deps: ArkivMirrorDeps): Job {
  return {
    name: "arkiv-mirror",
    intervalMs: deps.intervalMs,
    async run() {
      const [tokens, causes] = await Promise.all([deps.indexer.listTokens(), deps.indexer.listCauses()]);
      if (tokens.rejected + causes.rejected > 0) {
        deps.log("warn", "indexer rows rejected by schema", { tokens: tokens.rejected, causes: causes.rejected });
      }
      const [existingCores, existingProfiles, existingCauses, currentBlock] = await Promise.all([
        deps.registry.listCores(),
        deps.registry.listProfiles(),
        deps.registry.listCauses(),
        deps.registry.currentBlock(),
      ]);
      const plan = planReconcile({
        chainId: deps.chainId,
        indexerTokens: tokens.items,
        indexerCauses: causes.items,
        existingCores,
        existingProfiles,
        existingCauses,
        currentBlock,
        renewBeforeBlocks: deps.renewBeforeBlocks ?? RENEW_BEFORE_BLOCKS,
      });
      const summary = await applyPlan(deps.registry, plan, {
        logger: registryLogger(deps.log),
        maxCreates: deps.maxCreates,
      });
      deps.log("info", "arkiv mirror run", { ...summary });
    },
  };
}
