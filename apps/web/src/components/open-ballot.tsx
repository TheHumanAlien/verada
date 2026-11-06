"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAppConfig, useDeps } from "@/components/providers";
import { TxStatus, useTx } from "@/components/use-tx";
import { openingErrorText, openingRequest, planOpening } from "@/lib/open-ballot";

/**
 * Offered while the current epoch's ballot is not prepared. The platform keeper only opens epochs
 * of tokens with recent fees, ballots or pin changes, so a quiet token's voter opens it here: the
 * button plans the same `openEpoch` / `prepareBallot` / `prepareCuratedBallot` the keeper would
 * send and the voter's wallet sends it.
 */
export function OpenBallot({ token, epoch }: { token: Address; epoch: bigint }) {
  const config = useAppConfig();
  const deps = useDeps();
  const qc = useQueryClient();
  const tx = useTx();
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const governor = config.governorAddress as Address;

  const confirmed = tx.receipt?.status === "success";
  useEffect(() => {
    if (confirmed) void qc.invalidateQueries({ queryKey: ["epoch-view", token] });
  }, [confirmed, qc, token]);

  async function open() {
    setError(undefined);
    tx.reset();
    setPlanning(true);
    let request: ReturnType<typeof openingRequest>;
    try {
      request = openingRequest(await planOpening(deps, governor, token, epoch), governor, config.chainId);
    } catch (e) {
      setPlanning(false);
      return setError(openingErrorText(e));
    }
    setPlanning(false);
    // Someone opened it meanwhile: just show it.
    if (!request) return void qc.invalidateQueries({ queryKey: ["epoch-view", token] });
    try {
      await tx.send(request as never);
    } catch {
      // Shown by TxStatus (wallet rejection, revert on estimate).
    }
  }

  return (
    <div role="group" aria-label="Open ballot">
      <p>
        Nobody has opened this week&apos;s ballot yet. Anyone can: the ballot is drawn on chain exactly as the platform keeper would draw
        it, and you pay the gas (about 2M gas for a full 32-option ballot).
      </p>
      <button type="button" onClick={() => void open()} disabled={planning || tx.isPending || Boolean(tx.hash && !tx.receipt)}>
        {planning ? "Preparing the ballot" : "Open this week's ballot"}
      </button>
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Ballot opening" />
    </div>
  );
}
