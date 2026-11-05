import { getAddress, type Address } from "viem";
import type { IndexerClient } from "../indexer-client.js";
import type { Log } from "../jobs/types.js";
import { redact, type FactoryLogReader } from "./chain.js";

export interface TokenSourceDeps {
  indexer?: Pick<IndexerClient, "listTokens">;
  /** `TokenCreated` log reader over the factory, used when the indexer is unset or down. */
  factoryLogs?: FactoryLogReader;
  factoryDeployBlock?: bigint;
  log: Log;
}

/**
 * Lists the tokens the keeper looks after: the indexer's `/api/tokens` (all pages) when it answers,
 * otherwise the factory's `TokenCreated` logs, scanned incrementally and remembered in memory.
 */
export function createTokenSource(deps: TokenSourceDeps): () => Promise<Address[]> {
  const fromChain = new Set<Address>();
  let nextBlock = deps.factoryDeployBlock ?? 0n;

  const scan = async (): Promise<Address[]> => {
    if (!deps.factoryLogs) throw new Error("no token source: indexer unavailable and FACTORY_ADDRESS not set");
    const r = await deps.factoryLogs.tokensCreated(nextBlock);
    for (const t of r.tokens) fromChain.add(getAddress(t));
    nextBlock = r.toBlock + 1n;
    return [...fromChain];
  };

  return async () => {
    if (deps.indexer) {
      try {
        const { items } = await deps.indexer.listTokens();
        const out = new Set<Address>(items.map((t) => getAddress(t.address)));
        for (const t of fromChain) out.add(t);
        return [...out];
      } catch (err) {
        deps.log("warn", "indexer unavailable; listing tokens from factory logs", {
          error: redact(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return scan();
  };
}
