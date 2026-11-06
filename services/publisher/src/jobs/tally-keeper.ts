import type { KeeperConfig } from "../env.js";
import type { IndexerClient } from "../indexer-client.js";
import { createBallotPreparer, type BallotReader } from "../keeper/ballot.js";
import type { ChainReader, ChainWriter, FactoryLogReader } from "../keeper/chain.js";
import { createZamaDecryptor, type PublicDecryptor } from "../keeper/decrypt.js";
import { createKeeper } from "../keeper/keeper.js";
import { createTokenSource } from "../keeper/tokens.js";
import { createViemChain } from "../keeper/viem-chain.js";
import type { Job, Log } from "./types.js";

/**
 * Zama tally keeper: prepares current-epoch ballots that need rotation draws (entries and proofs
 * from the indexer's catalogue), closes ended epochs and takeover polls, relays the public decryption of their
 * encrypted tallies to `ZamaVotingScheme.submitTally`, finalizes epochs, records takeover tallies and
 * executes successful takeovers. Scheduled only with `KEEPER_ENABLED=true` and all of
 * {@link REQUIRED_KEEPER_ENV} set. See README "Tally keeper".
 */
export interface TallyKeeperDeps {
  keeper: KeeperConfig;
  chainId: number;
  indexer?: Pick<IndexerClient, "listTokens" | "catalogEntries" | "agentPicks">;
  log: Log;
  /** Test seams: replace the viem chain or the Zama decryptor. */
  chain?: { reader: ChainReader; writer: ChainWriter; ballots?: BallotReader; factoryLogs?: FactoryLogReader };
  decryptor?: PublicDecryptor;
}

export const REQUIRED_KEEPER_ENV = [
  "KEEPER_PRIVATE_KEY",
  "ETH_RPC_URL",
  "EPOCH_GOVERNOR_ADDRESS",
  "VOTING_SCHEME_ADDRESS",
  "TAKEOVER_GOVERNOR_ADDRESS",
] as const;

/** Names of the required keeper variables that are not set. */
export function missingKeeperEnv(k: KeeperConfig): string[] {
  const present: Record<(typeof REQUIRED_KEEPER_ENV)[number], boolean> = {
    KEEPER_PRIVATE_KEY: Boolean(k.privateKey),
    ETH_RPC_URL: k.rpcUrls.length > 0,
    EPOCH_GOVERNOR_ADDRESS: Boolean(k.epochGovernor),
    VOTING_SCHEME_ADDRESS: Boolean(k.votingScheme),
    TAKEOVER_GOVERNOR_ADDRESS: Boolean(k.takeoverGovernor),
  };
  return REQUIRED_KEEPER_ENV.filter((n) => !present[n]);
}

export function createTallyKeeperJob(deps: TallyKeeperDeps): Job | null {
  const k = deps.keeper;
  if (!k.enabled) {
    if (k.privateKey && k.rpcUrls.length > 0) deps.log("info", "tally keeper configured but KEEPER_ENABLED is not true; not scheduled");
    return null;
  }
  const missing = missingKeeperEnv(k);
  if (missing.length > 0) {
    deps.log("warn", "KEEPER_ENABLED but required variables are not set; tally keeper not scheduled", { missing });
    return null;
  }
  const epochGovernor = k.epochGovernor!;
  const takeoverGovernor = k.takeoverGovernor!;
  const zamaScheme = k.votingScheme!;

  let chain = deps.chain;
  let decryptor = deps.decryptor;
  try {
    if (!chain || !decryptor) {
      const viemChain = createViemChain({
        chainId: deps.chainId,
        rpcUrls: k.rpcUrls,
        privateKey: k.privateKey!,
        epochGovernor,
        takeoverGovernor,
        // A scan from block 0 would take millions of requests, so the fallback needs a start block.
        factory: k.factoryDeployBlock !== undefined ? k.factory : undefined,
      });
      chain ??= viemChain;
      decryptor ??= createZamaDecryptor({
        chainId: deps.chainId,
        publicClient: viemChain.publicClient,
        rpcUrl: k.rpcUrls[0]!,
        relayerUrl: k.zamaRelayerUrl,
        apiKey: k.zamaRelayerApiKey,
      });
    }
  } catch (err) {
    deps.log("error", "tally keeper not scheduled", { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return null;
  }
  if (deps.chainId === 1 && !k.zamaRelayerApiKey && !deps.decryptor) {
    deps.log("warn", "ZAMA_RELAYER_API_KEY not set; the mainnet Zama relayer requires one for public decryption");
  }
  if (k.factory && k.factoryDeployBlock === undefined) {
    deps.log("warn", "FACTORY_ADDRESS set without FACTORY_DEPLOY_BLOCK; factory-log token fallback disabled");
  }
  if (!deps.indexer && !chain.factoryLogs) {
    deps.log("warn", "tally keeper has no token source (INDEXER_URL, or FACTORY_ADDRESS with FACTORY_DEPLOY_BLOCK)");
  }

  const indexer = deps.indexer;
  if (!indexer) deps.log("warn", "tally keeper has no INDEXER_URL; ballots that need rotation draws are left to other keepers");
  const ballots =
    indexer && chain.ballots
      ? createBallotPreparer({
          reader: chain.ballots,
          entries: { entries: (at) => indexer.catalogEntries(at) },
          picks: { picks: (label, epoch, region) => indexer.agentPicks(label, epoch, region) },
        })
      : undefined;

  const keeper = createKeeper({
    reader: chain.reader,
    writer: chain.writer,
    decryptor,
    ballots,
    tokens: createTokenSource({ indexer: deps.indexer, factoryLogs: chain.factoryLogs, factoryDeployBlock: k.factoryDeployBlock, log: deps.log }),
    epochGovernor,
    takeoverGovernor,
    zamaScheme,
    dryRun: k.dryRun,
    maxTxPerRun: k.maxTxPerRun,
    lookbackEpochs: k.lookbackEpochs,
    log: deps.log,
  });
  deps.log("info", "tally keeper ready", {
    keeper: chain.writer.account,
    chainId: deps.chainId,
    dryRun: k.dryRun,
    maxTxPerRun: k.maxTxPerRun,
    lookbackEpochs: k.lookbackEpochs,
  });

  return {
    name: "tally-keeper",
    intervalMs: k.intervalMs,
    async run() {
      const summary = await keeper.run();
      deps.log("info", "tally keeper run", { ...summary });
    },
  };
}
