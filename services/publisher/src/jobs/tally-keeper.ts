import type { Job, Log } from "./types.js";

/**
 * Zama tally keeper (stub).
 *
 * Intended behaviour: once an epoch closes, request public decryption of each token's encrypted
 * vote tallies through the Zama relayer and submit the decrypted result with its KMS proof to the
 * voting scheme contract, which finalizes the epoch in `EpochGovernor`. It will sign with
 * `KEEPER_PRIVATE_KEY` over `ETH_RPC_URL` (both already provisioned by infra).
 *
 * TODO: implement once the `ZamaVotingScheme` ABI and the decryption flow are final. Until then
 * this job is never scheduled (`createTallyKeeperJob` returns null).
 */
export interface TallyKeeperDeps {
  keeperPrivateKey?: string;
  ethRpcUrl?: string;
  intervalMs: number;
  log: Log;
}

export function createTallyKeeperJob(deps: TallyKeeperDeps): Job | null {
  if (deps.keeperPrivateKey && deps.ethRpcUrl) {
    deps.log("info", "tally keeper configured but not implemented yet; not scheduled");
  }
  return null;
}
