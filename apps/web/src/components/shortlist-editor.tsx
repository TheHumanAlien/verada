"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address, Hex } from "viem";
import { PINNED_MAX } from "@verada/sdk";
import { epochGovernorAbi } from "@verada/sdk/abis";
import { CatalogBrowser } from "@/components/catalog-browser";
import { useAppConfig, useDeps } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { CatalogOrg, TokenDetail } from "@/lib/indexer";
import { addPin, entryInFocus, type PinDraft } from "@/lib/profile";

/**
 * The controller's pinned causes: up to PINNED_MAX catalogue orgs inside the token's focus that lead
 * every ballot from the next epoch. The rest of each ballot is drawn from the focus pool.
 */
export function ShortlistEditor({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const deps = useDeps();
  const { address: account } = useAccount();
  const tx = useTx();
  const [draft, setDraft] = useState<PinDraft[]>([]);
  const [error, setError] = useState<string>();
  const focus = detail.focus;

  // Rebuild the draft from the pins on chain: each needs its in-focus entry and proof to be saved again.
  useEffect(() => {
    let cancelled = false;
    const pins = detail.shortlist ?? [];
    if (!focus || pins.length === 0) {
      setDraft([]);
      return;
    }
    void (async () => {
      const out: PinDraft[] = [];
      for (const causeId of pins) {
        const found = await deps.indexer.catalogOrg(causeId).catch(() => null);
        const entry = found && entryInFocus(found.entries, BigInt(focus.categoryMask), focus.regionMask);
        if (found && entry) out.push(toDraft(found.org, entry));
      }
      if (!cancelled) setDraft(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.shortlist, focus, deps.indexer]);

  if (!sameAddress(account, detail.profile?.controller)) return null;
  const governor = config.governorAddress;

  async function add(org: CatalogOrg) {
    setError(undefined);
    if (!focus) return setError("The token's cause focus is not known yet");
    const found = await deps.indexer.catalogOrg(org.orgId).catch(() => null);
    const entry = found && entryInFocus(found.entries, BigInt(focus.categoryMask), focus.regionMask);
    if (!found || !entry) return setError(`${org.name} is outside this token's focus`);
    const next = addPin(draft, toDraft(found.org, entry));
    if (typeof next === "string") return setError(next);
    setDraft(next);
  }

  function save(list: PinDraft[]) {
    setError(undefined);
    if (!governor) return setError("governorAddress is not configured (config.json)");
    tx.reset();
    const pins = list.map((p) => ({ orgId: p.orgId, bucket: p.bucket, index: p.index, proof: p.proof }));
    void tx.send({ address: governor, abi: epochGovernorAbi, functionName: "setShortlist", args: [token, pins], chainId: config.chainId }).catch(() => {});
  }

  return (
    <section aria-label="Pinned causes">
      <h2>Pinned causes</h2>
      <p>
        Up to {PINNED_MAX} causes from this token&apos;s focus that lead every ballot. The other options are drawn in rotation from the
        whole focus pool, so every charity in it gets its turn. Changes take effect from the next epoch once the current ballot is
        prepared.
      </p>
      {draft.length === 0 ? (
        <p>No causes pinned: every option is drawn from the focus pool.</p>
      ) : (
        <ol>
          {draft.map((p) => (
            <li key={p.causeId}>
              {p.name}{" "}
              <button type="button" onClick={() => setDraft((d) => d.filter((x) => x.causeId !== p.causeId))}>
                Unpin {p.name}
              </button>
            </li>
          ))}
        </ol>
      )}
      {focus ? (
        <CatalogBrowser onSelect={(o) => void add(o)} selectLabel="Pin" within={{ categories: focus.categories, regions: focus.regions }} />
      ) : (
        <p role="note">The token&apos;s cause focus is not indexed yet.</p>
      )}
      <p>
        <button type="button" disabled={tx.isPending} onClick={() => save(draft)}>
          Save pinned causes
        </button>{" "}
        <button type="button" disabled={tx.isPending || draft.length === 0} onClick={() => save([])}>
          Unpin all
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Pinned causes update" />
    </section>
  );
}

function toDraft(org: CatalogOrg, entry: { bucket: number; index: number; proof: string[] }): PinDraft {
  return {
    causeId: org.causeId as Hex,
    orgId: org.orgId as Hex,
    bucket: entry.bucket,
    index: entry.index,
    proof: entry.proof as Hex[],
    name: org.name,
  };
}
