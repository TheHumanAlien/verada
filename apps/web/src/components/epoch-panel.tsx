"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { argmax, MAX_BALLOT_OPTIONS } from "@verada/sdk";
import { epochGovernorAbi } from "@verada/sdk/abis";
import { useCatalogNames } from "@/components/catalog-browser";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, formatTime, TxStatus } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { loadCauses, loadEpochView } from "@/lib/data";
import type { CauseSummary, EpochDetail, OptionSource, TokenDetail } from "@/lib/indexer";
import { ballotOptions } from "@/lib/profile";

export function useCauses() {
  const deps = useDeps();
  return useQuery({ queryKey: ["causes"], queryFn: () => loadCauses(deps), retry: false, staleTime: 300_000 });
}

/** Registry name first, then the catalogue name (catalogue orgs reach the registry only when they win). */
export function causeName(causes: Map<string, CauseSummary> | undefined, id: string, catalog?: Map<string, { name: string }>): string {
  return causes?.get(id.toLowerCase())?.name ?? catalog?.get(id.toLowerCase())?.name ?? id;
}

export const OPTION_SOURCE_LABELS: Record<OptionSource, string> = { pinned: "Pinned", curated: "Curated", rotation: "Rotation" };

const OPTION_SOURCE_TITLES: Record<OptionSource, string> = {
  pinned: "Pinned by the token's controller",
  curated: "Picked by the curator agent for one of the token's causes",
  rotation: "Drawn in rotation from the token's focus pool",
};

/**
 * Source of each option shown: before the ballot is prepared the options are the token's pins;
 * after, the indexer's per-option sources (null entries when it does not report them, e.g. an
 * older indexer or the chain fallback).
 */
export function shownOptionSources(frozen: boolean, options: readonly string[], ed: Pick<EpochDetail, "options" | "optionSources"> | null): (OptionSource | null)[] {
  if (!frozen) return options.map(() => "pinned");
  const given = ed?.optionSources;
  if (!given || given.length !== options.length) return options.map(() => null);
  return given.map((s) => s ?? null);
}

/** "2 pinned, 3 curated, 27 rotation", counting only known sources; null when none is known. */
export function ballotMakeup(sources: readonly (OptionSource | null)[]): string | null {
  const parts = (["pinned", "curated", "rotation"] as const)
    .map((k) => [k, sources.filter((s) => s === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length > 0 && sources.every((s) => s !== null) ? parts.join(", ") : null;
}

function SourceTag({ source }: { source: OptionSource | null }) {
  if (!source) return null;
  return (
    <>
      {" "}
      <small data-source={source} title={OPTION_SOURCE_TITLES[source]}>
        [{OPTION_SOURCE_LABELS[source]}]
      </small>
    </>
  );
}

function pollState(detail: { poll: { opened: boolean; closed: boolean; isFinal: boolean } | null; finalized?: boolean } | null): string {
  const poll = detail?.poll;
  if (detail?.finalized) return "Finalized";
  if (!poll || !poll.opened) return "Not opened yet (opens when the ballot is prepared)";
  if (poll.isFinal) return "Tally decrypted";
  if (poll.closed) return "Closed, waiting for the tally to be decrypted";
  return "Open for ballots";
}

/** The token's current epoch: options, poll state, the connected account's weight, and the vote form. */
export function EpochPanel({ token, detail }: { token: Address; detail: TokenDetail }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const causes = useCauses();

  const view = useQuery({
    queryKey: ["epoch-view", token],
    queryFn: () => loadEpochView(config, deps, token),
    enabled: Boolean(config.governorAddress),
    retry: false,
  });
  const epoch = view.data?.epoch;
  const ed = view.data?.detail ?? null;
  const { options, frozen } = ballotOptions({
    prepared: Boolean(ed?.prepared || ed?.poll?.opened),
    epochOptions: ed?.options ?? [],
    pinned: detail.shortlist,
  });
  const sources = shownOptionSources(frozen, options, ed);
  const makeup = frozen ? ballotMakeup(sources) : null;
  const names = useCatalogNames([...options, ...(ed?.winningCause ? [ed.winningCause] : [])]);
  const nameOf = (id: string) => causeName(causes.data, id, names.data);

  // Address-keyed reads go through the account's own isolated client, never the indexer.
  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const mine = useQuery({
    queryKey: ["epoch-account", token, epoch?.toString(), account],
    queryFn: async () => {
      const g = { address: config.governorAddress as Address, abi: epochGovernorAbi } as const;
      const [weight, voted] = await Promise.all([
        accountClient!.readContract({ ...g, functionName: "weightOf", args: [token, epoch!, account!] }),
        accountClient!.readContract({ ...g, functionName: "hasVoted", args: [token, epoch!, account!] }),
      ]);
      return { weight, voted };
    },
    enabled: Boolean(accountClient && epoch !== undefined && config.governorAddress),
    retry: false,
  });

  const ballot = useCastBallot();
  const [choice, setChoice] = useState<number | null>(null);
  const [formError, setFormError] = useState<string>();

  if (!config.governorAddress) return <section aria-label="Current epoch"><h2>Current epoch</h2><p>governorAddress is not configured (config.json)</p></section>;

  function onVote(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (epoch === undefined) return setFormError("Current epoch unknown");
    if (!frozen) return setFormError("The ballot is not prepared yet");
    if (choice === null || choice >= options.length) return setFormError("Choose a cause");
    const scheme = ed?.poll?.scheme as Address | undefined;
    void ballot.cast({ governor: config.governorAddress!, token, scope: epoch, choice, scheme });
  }

  const counts = ed?.poll?.isFinal ? ed.poll.counts : null;
  const leader = counts ? argmax(counts.map((c) => BigInt(c))) : -1;

  return (
    <section aria-label="Current epoch">
      <h2>Current epoch{epoch !== undefined ? ` ${epoch}` : ""}</h2>
      {view.isLoading && <p role="status">Loading epoch</p>}
      {view.error && <p role="alert">Could not load the epoch: {errorText(view.error)}</p>}
      {view.data && (
        <>
          <p>State: {pollState(ed)}</p>
          {view.data.source === "chain" && <p role="note">Epoch read directly from the chain.</p>}
          <dl>
            <dt>Voting window</dt>
            <dd>
              {formatTime(ed?.start)} to {formatTime(ed?.end)}
            </dd>
            <dt>Weight snapshot</dt>
            <dd>{formatTime(ed?.snapshot)}</dd>
            {ed?.poll && (
              <>
                <dt>Ballots</dt>
                <dd>{ed.poll.ballotCount}</dd>
              </>
            )}
            {ed?.winningCause && (
              <>
                <dt>Winning cause</dt>
                <dd>{nameOf(ed.winningCause)}</dd>
              </>
            )}
          </dl>
          {ed?.poolSize !== undefined && frozen && <p>Drawn from a focus pool of {ed.poolSize} organizations.</p>}
          {makeup && (
            <p>
              Options: {makeup}. Pinned causes come first, then the curator agents&apos; picks, then rotation draws.
            </p>
          )}
          {!frozen && (
            <p role="note">
              This epoch&apos;s ballot is not prepared yet. {options.length > 0 ? "The pinned causes below lead it; " : ""}up to{" "}
              {MAX_BALLOT_OPTIONS} options are filled from the curator agents&apos; picks and then in rotation from the token&apos;s focus pool
              when it is prepared, and voting opens then.
            </p>
          )}
          {frozen && options.length === 0 && <p>This epoch&apos;s ballot has no options; it pays the platform&apos;s fallback cause.</p>}
          <ol start={0}>
            {options.map((id, i) => (
              <li key={id}>
                {nameOf(id)}
                {counts && ` (${counts[i] ?? "0"} votes${i === leader ? ", leading" : ""})`}
                <SourceTag source={sources[i] ?? null} />
              </li>
            ))}
          </ol>
        </>
      )}

      {!account ? (
        <p>Connect a wallet to see your voting weight and vote.</p>
      ) : (
        <>
          {mine.isLoading && <p role="status">Reading your weight privately</p>}
          {mine.error && <p role="alert">Could not read your weight: {errorText(mine.error)}</p>}
          {mine.data && (
            <p>
              Your weight: {String(mine.data.weight)} (whole tokens held at the snapshot){mine.data.voted ? ". You have voted in this epoch." : ""}
            </p>
          )}
          {frozen && options.length > 1 && !ed?.poll?.closed && !mine.data?.voted && (
            <form onSubmit={onVote} aria-label="Vote">
              <fieldset>
                <legend>Vote for a cause</legend>
                {options.map((id, i) => (
                  <p key={id}>
                    <label>
                      <input type="radio" name="choice" value={i} checked={choice === i} onChange={() => setChoice(i)} /> {nameOf(id)}
                      <SourceTag source={sources[i] ?? null} />
                    </label>
                  </p>
                ))}
              </fieldset>
              <p>Ballot: {ballot.adapter.label}</p>
              {ballot.adapter.placeholder && <p role="note">DEVELOPMENT BUILD: this ballot is not private.</p>}
              <button type="submit" disabled={ballot.phase === "encrypting" || ballot.tx.isPending}>
                {ballot.phase === "encrypting" ? "Encrypting" : ballot.tx.isPending ? "Confirm in wallet" : "Vote"}
              </button>
              {formError && <p role="alert">{formError}</p>}
              {ballot.error && <p role="alert">{ballot.error}</p>}
              <TxStatus tx={ballot.tx} label="Ballot" />
            </form>
          )}
        </>
      )}
    </section>
  );
}
