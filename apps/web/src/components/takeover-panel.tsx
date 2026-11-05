"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { TAKEOVER_AGAINST, TAKEOVER_FOR } from "@verada/sdk";
import { takeoverGovernorAbi } from "@verada/sdk/abis";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { useCastBallot } from "@/components/use-cast-ballot";
import { errorText, formatTime, sameAddress, shortAddress, TxStatus, useTx } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { loadTakeovers } from "@/lib/data";
import type { TakeoverItem } from "@/lib/indexer";

const PENDING = new Set(["Active", "Closing", "Succeeded"]);

const STATE_LABELS: Record<string, string> = {
  None: "Unknown proposal",
  Active: "Voting open",
  Closing: "Voting ended, waiting for the tally",
  Defeated: "Defeated",
  Succeeded: "Succeeded, ready to execute",
  Executed: "Executed",
  Canceled: "Canceled",
  Expired: "Expired (not executed in time)",
  Superseded: "Superseded (a newer proposal for this token was executed)",
};

export function takeoverStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function formatDuration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds > 0 && seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds > 0 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return `${seconds} s`;
}

/** `part / whole` as a percentage with two decimals, or null when `whole` is missing or zero. */
export function shareOf(part: string, whole: string | undefined): string | null {
  if (!whole || !/^\d+$/.test(whole) || !/^\d+$/.test(part) || BigInt(whole) === 0n) return null;
  const bp = (BigInt(part) * 10_000n) / BigInt(whole);
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}%`;
}

/** Community takeover: replace the profile controller by a FOR/AGAINST vote of holders. */
export function TakeoverPanel({ token, controller }: { token: Address; controller: string | null }) {
  const config = useAppConfig();
  const deps = useDeps();
  const governor = config.takeoverGovernorAddress;

  const list = useQuery({
    queryKey: ["takeovers", token],
    queryFn: () => loadTakeovers(config, deps, token),
    enabled: Boolean(governor),
    retry: false,
  });
  const params = useQuery({
    queryKey: ["takeover-params", governor],
    queryFn: () => deps.chain().readContract({ address: governor!, abi: takeoverGovernorAbi, functionName: "params" }),
    enabled: Boolean(governor),
    retry: false,
    staleTime: 600_000,
  });

  if (!governor) return null;
  const items = list.data?.data ?? [];
  const active = items.find((p) => PENDING.has(p.state)) ?? null;

  return (
    <section aria-label="Takeover">
      <h2>Community takeover</h2>
      <p>Holders can vote to replace the profile controller (currently {controller ?? "none"}).</p>
      {params.data && (
        <p>
          Voting lasts {formatDuration(params.data.votingPeriod)}; quorum {params.data.quorumBps / 100}% of the circulating supply; proposing
          needs {params.data.proposalThresholdBps / 100}% of it; tokens must be {formatDuration(params.data.minTokenAge)} old. Holding
          period {formatDuration(params.data.lookback)}: your weight is the smaller of your votes at the snapshot and{" "}
          {formatDuration(params.data.lookback)} earlier.
        </p>
      )}
      {list.isLoading && <p role="status">Loading proposals</p>}
      {list.error && <p role="alert">Could not load proposals: {errorText(list.error)}</p>}
      {active ? <ActiveProposal governor={governor} token={token} proposal={active} /> : list.data && <ProposeForm governor={governor} token={token} />}
      {items.length > 0 && (
        <>
          <h3>History</h3>
          <ul>
            {items.map((p) => (
              <li key={p.proposalId}>
                #{p.proposalId} {takeoverStateLabel(p.state)}: new controller {shortAddress(p.newController)}, proposed by {shortAddress(p.proposer)}, ends {formatTime(p.end)}
                {p.tallied && `, FOR ${p.forWeight} / AGAINST ${p.againstWeight} (quorum ${p.quorumWeight})`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ActiveProposal({ governor, token, proposal: p }: { governor: Address; token: Address; proposal: TakeoverItem }) {
  const config = useAppConfig();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const ballot = useCastBallot();
  const tx = useTx();
  const id = BigInt(p.proposalId);

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const mine = useQuery({
    queryKey: ["takeover-account", p.proposalId, account],
    queryFn: async () => {
      const g = { address: governor, abi: takeoverGovernorAbi } as const;
      const [weight, voted] = await Promise.all([
        accountClient!.readContract({ ...g, functionName: "weightOf", args: [id, account!] }),
        accountClient!.readContract({ ...g, functionName: "hasVoted", args: [id, account!] }),
      ]);
      return { weight, voted };
    },
    enabled: Boolean(accountClient) && p.state === "Active",
    retry: false,
  });

  function action(functionName: "closeProposal" | "recordTally" | "execute" | "cancel") {
    tx.reset();
    void tx.send({ address: governor, abi: takeoverGovernorAbi, functionName, args: [id], chainId: config.chainId }).catch(() => {});
  }

  return (
    <div>
      <h3>Proposal #{p.proposalId}: {takeoverStateLabel(p.state)}</h3>
      <dl>
        <dt>New controller</dt>
        <dd>{p.newController}</dd>
        <dt>Proposer</dt>
        <dd>{p.proposer}</dd>
        <dt>Voting</dt>
        <dd>
          {formatTime(p.start)} to {formatTime(p.end)}
        </dd>
        <dt>Execute before</dt>
        <dd>{formatTime(p.executionDeadline)}</dd>
        <dt>Weight snapshots</dt>
        <dd>
          {formatTime(p.snapshot)}
          {p.lookbackSnapshot !== undefined && ` and ${formatTime(p.lookbackSnapshot)} (the smaller counts)`}
        </dd>
        <dt>Quorum (whole tokens)</dt>
        <dd>
          {p.quorumWeight}
          {p.circulatingWeight !== undefined && ` of ${p.circulatingWeight} circulating`}
          {shareOf(p.quorumWeight, p.circulatingWeight) && ` (${shareOf(p.quorumWeight, p.circulatingWeight)})`}
        </dd>
        {p.ballotCount > 0 && (
          <>
            <dt>Ballots</dt>
            <dd>{p.ballotCount}</dd>
          </>
        )}
        {p.tallied && (
          <>
            <dt>Result</dt>
            <dd>
              FOR {p.forWeight}, AGAINST {p.againstWeight}
            </dd>
          </>
        )}
      </dl>

      {p.state === "Active" && account && (
        <>
          {mine.data && (
            <p>
              Your weight: {String(mine.data.weight)}
              {mine.data.voted ? ". You have voted on this proposal." : ""}
            </p>
          )}
          {mine.error && <p role="alert">Could not read your weight: {errorText(mine.error)}</p>}
          {!mine.data?.voted && (
            <p>
              <button type="button" disabled={ballot.phase === "encrypting" || ballot.tx.isPending} onClick={() => void ballot.cast({ governor, token, scope: id, choice: TAKEOVER_FOR })}>
                Vote FOR
              </button>{" "}
              <button type="button" disabled={ballot.phase === "encrypting" || ballot.tx.isPending} onClick={() => void ballot.cast({ governor, token, scope: id, choice: TAKEOVER_AGAINST })}>
                Vote AGAINST
              </button>
            </p>
          )}
          {ballot.phase === "encrypting" && <p role="status">Encrypting your ballot</p>}
          {ballot.error && <p role="alert">{ballot.error}</p>}
          <TxStatus tx={ballot.tx} label="Ballot" />
        </>
      )}
      {p.state === "Active" && !account && <p>Connect a wallet to vote.</p>}

      <p>
        {p.state === "Closing" && !p.closed && (
          <button type="button" onClick={() => action("closeProposal")} disabled={tx.isPending}>
            Close voting and request the tally
          </button>
        )}
        {p.closed && !p.tallied && (
          <button type="button" onClick={() => action("recordTally")} disabled={tx.isPending}>
            Record the decrypted tally
          </button>
        )}
        {p.state === "Succeeded" && (
          <button type="button" onClick={() => action("execute")} disabled={tx.isPending}>
            Execute: set the new controller
          </button>
        )}
        {p.state === "Active" && sameAddress(account, p.proposer) && (
          <button type="button" onClick={() => action("cancel")} disabled={tx.isPending}>
            Cancel proposal
          </button>
        )}
      </p>
      <TxStatus tx={tx} label="Takeover transaction" />
    </div>
  );
}

function ProposeForm({ governor, token }: { governor: Address; token: Address }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const tx = useTx();
  const [newController, setNewController] = useState("");
  const [error, setError] = useState<string>();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const v = newController.trim();
    if (!isAddress(v)) return setError("New controller must be an address");
    tx.reset();
    void tx.send({ address: governor, abi: takeoverGovernorAbi, functionName: "propose", args: [token, v], chainId: config.chainId }).catch(() => {});
  }

  return (
    <form onSubmit={onSubmit} aria-label="Propose takeover">
      <p>No takeover is pending.</p>
      <label>
        Propose a new controller <input value={newController} onChange={(e) => setNewController(e.target.value)} placeholder="0x..." />
      </label>{" "}
      <button type="submit" disabled={!account || tx.isPending}>
        Propose takeover
      </button>
      {!account && <p>Connect a wallet to propose.</p>}
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Proposal" />
    </form>
  );
}
