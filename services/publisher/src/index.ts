import { serve } from "@hono/node-server";
import { createArkivRegistry } from "@verada/arkiv-registry";
import { createApp } from "./app.js";
import { readConfig } from "./env.js";
import { createIndexerClient } from "./indexer-client.js";
import { createArkivExtendJob } from "./jobs/arkiv-extend.js";
import { createArkivMirrorJob, registryLogger } from "./jobs/arkiv-mirror.js";
import { startJobs } from "./jobs/runner.js";
import { createStampWatchJob } from "./jobs/stamp-watch.js";
import { createTallyKeeperJob } from "./jobs/tally-keeper.js";
import type { Job, Log } from "./jobs/types.js";
import { createSwarmClient } from "./swarm.js";

const log: Log = (level, msg, data) => {
  const line = JSON.stringify({ level, msg, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const config = readConfig(process.env);
const { swarm: s } = config;
const swarm =
  s.gatewayUrl && s.batchId
    ? createSwarmClient({ gatewayUrl: s.gatewayUrl, batchId: s.batchId, authSecret: s.authSecret, stampsUrl: s.stampsUrl })
    : undefined;

const jobs: Job[] = [];
if (swarm) jobs.push(createStampWatchJob({ swarm, intervalMs: Math.max(config.jobIntervalMs, 600_000), log }));

if (config.arkiv.enabled) {
  if (!config.arkiv.privateKey) {
    log("warn", "ARKIV_ENABLED but ARKIV_PRIVATE_KEY is not set; Arkiv jobs not scheduled");
  } else {
    const registry = createArkivRegistry({
      chain: config.arkiv.chain,
      accessKey: config.arkiv.accessKey,
      privateKey: config.arkiv.privateKey,
      rpcUrl: config.arkiv.rpcUrl,
      dryRun: config.arkiv.dryRun,
      logger: registryLogger(log),
    });
    log("info", "arkiv registry ready", { platform: registry.platform, chain: config.arkiv.chain, dryRun: registry.dryRun });
    if (config.indexerUrl) {
      jobs.push(
        createArkivMirrorJob({
          indexer: createIndexerClient(config.indexerUrl),
          registry,
          chainId: config.chainId,
          intervalMs: config.jobIntervalMs,
          log,
        }),
      );
    } else {
      log("warn", "INDEXER_URL not set; arkiv-mirror not scheduled");
    }
    jobs.push(createArkivExtendJob({ registry, intervalMs: Math.max(config.jobIntervalMs, 3_600_000), log }));
  }
}
const keeper = createTallyKeeperJob({
  keeper: config.keeper,
  chainId: config.chainId,
  indexer: config.indexerUrl ? createIndexerClient(config.indexerUrl) : undefined,
  log,
});
if (keeper) jobs.push(keeper);

const app = createApp({ config, swarm, log });
const stopJobs = startJobs(jobs, log);
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  log("info", "publisher listening", { port: info.port, uploads: Boolean(swarm && s.publicGatewayUrl) });
});

const shutdown = () => {
  stopJobs();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
