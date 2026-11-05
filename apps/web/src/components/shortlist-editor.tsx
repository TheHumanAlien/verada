"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address, Hex } from "viem";
import { MAX_BALLOT_OPTIONS } from "@verada/sdk";
import { epochGovernorAbi } from "@verada/sdk/abis";
import { CauseSearch } from "@/components/cause-search";
import { causeName, useCauses } from "@/components/epoch-panel";
import { useAppConfig } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { CauseSummary, TokenDetail } from "@/lib/indexer";
import { addToShortlist } from "@/lib/profile";

/** The controller's shortlist of up to 10 active causes; frozen into each epoch when it opens. */
export function ShortlistEditor({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const causes = useCauses();
  const tx = useTx();
  const [draft, setDraft] = useState<Hex[]>((detail.shortlist ?? []) as Hex[]);
  const [error, setError] = useState<string>();

  useEffect(() => setDraft((detail.shortlist ?? []) as Hex[]), [detail.shortlist]);

  if (!sameAddress(account, detail.profile?.controller)) return null;
  const governor = config.governorAddress;

  function add(c: CauseSummary) {
    setError(undefined);
    const known = causes.data?.get(c.causeId.toLowerCase());
    if (causes.data && !known?.isDeployed) return setError(`${c.name} is not an active cause in the registry yet`);
    const next = addToShortlist(draft, c.causeId as Hex);
    if (typeof next === "string") return setError(next);
    setDraft(next);
  }

  function save(list: Hex[]) {
    setError(undefined);
    if (!governor) return setError("governorAddress is not configured (config.json)");
    tx.reset();
    void tx.send({ address: governor, abi: epochGovernorAbi, functionName: "setShortlist", args: [token, list], chainId: config.chainId }).catch(() => {});
  }

  const active = [...(causes.data?.values() ?? [])].filter((c) => c.isDeployed);

  return (
    <section aria-label="Shortlist">
      <h2>Shortlist</h2>
      <p>
        Up to {MAX_BALLOT_OPTIONS} active causes holders choose between. Changes apply from the next epoch that opens.
        {detail.shortlist?.length ? "" : " This token currently uses the platform default."}
      </p>
      <ol start={0}>
        {draft.map((id) => (
          <li key={id}>
            {causeName(causes.data, id)}{" "}
            <button type="button" onClick={() => setDraft((d) => d.filter((x) => x !== id))}>
              Remove {causeName(causes.data, id)}
            </button>
          </li>
        ))}
      </ol>
      {active.length > 0 && (
        <details>
          <summary>Active causes in the registry</summary>
          <ul>
            {active.map((c) => (
              <li key={c.causeId}>
                {c.name}{" "}
                <button type="button" onClick={() => add(c)} disabled={draft.length >= MAX_BALLOT_OPTIONS}>
                  Add {c.name}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <CauseSearch onSelect={add} />
      <p>
        <button type="button" disabled={draft.length === 0 || tx.isPending} onClick={() => save(draft)}>
          Save shortlist
        </button>{" "}
        <button type="button" disabled={tx.isPending} onClick={() => save([])}>
          Use the platform default
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Shortlist update" />
    </section>
  );
}
