import { serve } from "@hono/node-server";
import { createArkivRegistry } from "@verada/arkiv-registry";
import { localKeySigner, oneClawSigner } from "@verada/curator";
import { createPublicClient, fallback, http } from "viem";
import { mainnet } from "viem/chains";
import { viemCuratorChain } from "./agents.js";
import { createApp } from "./app.js";
import { createMainnetFacilitator, guardedFacilitatorSigner, MAINNET_USDC, type TxSender } from "./facilitator.js";
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

const rpcUrls = config.keeper.rpcUrls;
const curators = config.curatorRegistry && rpcUrls.length > 0 ? viemCuratorChain(rpcUrls, config.curatorRegistry) : undefined;
if (!curators) log("info", "curator reports disabled (CURATOR_REGISTRY_ADDRESS or ETH_RPC_URL unset)");

async function mainnetFacilitator() {
  const f = config.facilitator;
  if (!f.enabled) return undefined;
  if (!f.token || !f.payTo || rpcUrls.length === 0 || (!f.oneClaw && !f.privateKey)) {
    log("warn", "X402_FACILITATOR_ENABLED needs X402_FACILITATOR_TOKEN, X402_FACILITATOR_PAY_TO, ETH_RPC_URL and a settlement key; facilitator not mounted");
    return undefined;
  }
  const client = createPublicClient({ chain: mainnet, transport: fallback(rpcUrls.map((u) => http(u))) });
  const signer = f.oneClaw ? oneClawSigner({ agentId: f.oneClaw.agentId, apiKey: f.oneClaw.apiKey, baseUrl: f.oneClaw.baseUrl }) : localKeySigner(f.privateKey!, rpcUrls[0]!);
  const sender: TxSender = { address: await signer.address(), send: (to, data) => signer.send(to, data) };
  const facilitator = createMainnetFacilitator(guardedFacilitatorSigner(client, sender, f.usdc ?? MAINNET_USDC), f.network);
  log("info", "x402 facilitator ready", { network: f.network, settler: sender.address, signer: f.oneClaw ? "1claw" : "local" });
  return { facilitator, token: f.token, network: f.network, payTo: f.payTo };
}

const app = createApp({ config, swarm, log, curators, facilitator: await mainnetFacilitator() });
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
