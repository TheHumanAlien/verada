import type { ArkivRegistry, RegistryLogger } from "./client.js";
import { consoleLogger } from "./client.js";
import type { ReconcilePlan } from "./mapping.js";

export interface ApplyOptions {
  logger?: RegistryLogger;
  /** Cap on new tokens written per run, to bound one run's gas and duration (default 50). */
  maxCreates?: number;
}

export interface ApplySummary {
  dryRun: boolean;
  created: number;
  profilesCreated: number;
  patched: number;
  burned: number;
  extended: number;
  causesCreated: number;
  causesPatched: number;
  deferred: number;
  conflicts: number;
  failures: number;
}

/**
 * Applies a reconcile plan. Each operation is independent: a failure is logged (redacted) and the
 * rest still run; the next reconcile picks up whatever did not land.
 */
export async function applyPlan(
  registry: ArkivRegistry,
  plan: ReconcilePlan,
  opts: ApplyOptions = {},
): Promise<ApplySummary> {
  const log = opts.logger ?? consoleLogger;
  const maxCreates = opts.maxCreates ?? 50;
  const s: ApplySummary = {
    dryRun: registry.dryRun,
    created: 0,
    profilesCreated: 0,
    patched: 0,
    burned: 0,
    extended: 0,
    causesCreated: 0,
    causesPatched: 0,
    deferred: plan.deferred.length,
    conflicts: plan.conflicts.length,
    failures: 0,
  };

  const attempt = async (op: string, data: Record<string, unknown>, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      s.failures++;
      const message = registry.redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
      log.error(`arkiv ${op} failed`, { ...data, error: message });
      return false;
    }
  };

  for (const c of plan.conflicts) {
    log.warn("arkiv core disagrees with indexer (cores are immutable; not rewritten)", {
      token: c.token,
      key: c.key,
      fields: c.fields,
    });
  }
  if (plan.deferred.length > 0) {
    log.info("arkiv tokens deferred until the indexer reports a label", { count: plan.deferred.length });
  }

  // Burn first so an interrupted earlier create is sealed before anything else is written.
  if (plan.burns.length > 0 && (await attempt("burn", { count: plan.burns.length }, () => registry.burnCores(plan.burns)))) {
    s.burned = plan.burns.length;
  }
  for (const c of plan.creates.slice(0, maxCreates)) {
    if (await attempt("create", { token: c.core.token }, () => registry.createTokenRecords(c.core, c.profile))) s.created++;
  }
  for (const p of plan.profileCreates) {
    if (await attempt("create profile", { token: p.token }, () => registry.createProfile(p))) s.profilesCreated++;
  }
  for (const p of plan.patches) {
    if (await attempt("patch profile", { token: p.token, key: p.key }, () => registry.patchProfile(p.key, p.diff))) s.patched++;
  }
  for (const c of plan.causeCreates) {
    if (await attempt("create cause", { causeId: c.causeId }, () => registry.upsertCause(c))) s.causesCreated++;
  }
  for (const c of plan.causePatches) {
    if (await attempt("patch cause", { causeId: c.causeId, key: c.key }, () => registry.patchCause(c.key, c.diff))) s.causesPatched++;
  }
  if (plan.extends.length > 0 && (await attempt("extend", { count: plan.extends.length }, () => registry.extendExpiring(plan.extends)))) {
    s.extended = plan.extends.length;
  }
  return s;
}
