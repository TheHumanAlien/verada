"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { agentVaultAbi, curatorRegistryAbi } from "@verada/sdk/abis";
import { usdcText } from "@/components/agent-common";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { errorText, sameAddress, TxStatus, useTx } from "@/components/use-tx";
import { createAccountClient } from "@/lib/account-reads";
import { allowanceRequest, approveRequest, donateRequest, needsApproval, parseUsdcInput, usdcAddress, usdcBalanceRequest } from "@/lib/vault";

/** Why the form cannot send: shown as a note, or as an alert (with an optional retry) when something is wrong. */
interface Blocker {
  text: string;
  alert?: boolean;
  retry?: () => void;
}

/**
 * Donate USDC to an agent's vault: `USDC.approve(vault, amount)` when the allowance is short, then
 * `AgentVault.donate(amount, credit)`. The vault and its active flag come from
 * `CuratorRegistry.agentOf(categoryBit)` read on chain through the private RPC; the indexer's `vault`
 * only has to agree with it, and funds are never sent to an address the registry did not confirm.
 * Public credit is opt-in; the viewer's allowance and balance are read through their own isolated
 * RPC client, never through the indexer.
 */
export function AgentDonatePanel({ categoryBit, vault, name }: { categoryBit: number; vault: string; name: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const usdc = usdcAddress(config.chainId);
  const registryAddress = config.curatorRegistryAddress;

  const [amount, setAmount] = useState("");
  const [credit, setCredit] = useState(false);
  // What the sent donation asked for, so the confirmation does not follow later checkbox changes.
  const [sentCredit, setSentCredit] = useState(false);
  const [formError, setFormError] = useState<string>();
  // The approval sent (its hash and amount), and the allowance its confirmed receipt guarantees until
  // the next donation (an RPC can still answer the refetch with the pre-approval allowance). Both are
  // tied to the owner and vault they were sent for, so a wallet switch never inherits them.
  type Approval = { hash: string; amount: bigint; owner: string; vault: string };
  const [approving, setApproving] = useState<Approval | null>(null);
  const [approved, setApproved] = useState<Approval | null>(null);
  const approveTx = useTx();
  const donateTx = useTx();

  const registry = useQuery({
    queryKey: ["agent-registry-vault", registryAddress, categoryBit],
    queryFn: async () => {
      const a = await deps
        .chain()
        .readContract({ address: registryAddress!, abi: curatorRegistryAbi, functionName: "agentOf", args: [categoryBit] });
      return { vault: a.vault === zeroAddress ? null : (getAddress(a.vault) as Address), active: a.active };
    },
    enabled: Boolean(registryAddress),
    retry: false,
  });
  // Only an address the registry confirmed (and the indexer agrees with) is ever a transaction target.
  const onChain = registry.data;
  const vaultAddress = onChain?.vault && isAddress(vault) && sameAddress(onChain.vault, vault) ? onChain.vault : null;

  // The vault's own pause switch (the platform's); a failed read does not block the form.
  const paused = useQuery({
    queryKey: ["agent-vault-paused", vaultAddress],
    queryFn: () => deps.chain().readContract({ address: vaultAddress!, abi: agentVaultAbi, functionName: "paused" }),
    enabled: Boolean(vaultAddress),
    retry: false,
  });

  const accountClient = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  const funds = useQuery({
    queryKey: ["agent-donor-funds", vaultAddress, account],
    queryFn: async () => {
      const owner = account!;
      const [allowance, balance] = await Promise.all([
        accountClient!.readContract(allowanceRequest({ usdc: usdc!, owner, vault: vaultAddress!, chainId: config.chainId })),
        accountClient!.readContract(usdcBalanceRequest({ usdc: usdc!, owner, chainId: config.chainId })),
      ]);
      return { allowance, balance };
    },
    enabled: Boolean(accountClient && usdc && vaultAddress),
    retry: false,
  });
  const { refetch } = funds;

  // A confirmed approval covers its amount; a confirmed donation spends the allowance again.
  useEffect(() => {
    const r = approveTx.receipt;
    if (r?.status === "success" && approving && r.transactionHash === approving.hash) setApproved(approving);
  }, [approveTx.receipt, approving]);
  useEffect(() => {
    if (donateTx.receipt?.status !== "success") return;
    setApproving(null);
    setApproved(null);
  }, [donateTx.receipt]);
  // Either changes the allowance (and the balance): read them again.
  useEffect(() => {
    if (approveTx.receipt?.status === "success" || donateTx.receipt?.status === "success") void refetch();
  }, [approveTx.receipt, donateTx.receipt, refetch]);

  const blocker: Blocker | null = !registryAddress
    ? { text: "Donations are off on this site: no curator registry is configured, so the agent's vault cannot be checked on chain." }
    : registry.error
      ? { text: `Could not check the agent's vault on chain: ${errorText(registry.error)}`, alert: true, retry: () => void registry.refetch() }
      : !onChain
        ? { text: "Checking the agent's vault on chain" }
        : !onChain.vault
          ? { text: "This agent has no vault yet." }
          : !vaultAddress
            ? {
                text: `The vault the indexer lists (${vault || "none"}) is not the one registered on chain (${onChain.vault}), so donations are blocked.`,
                alert: true,
              }
            : !onChain.active || paused.data === true
              ? { text: `${name} is paused, so donations are closed for now.` }
              : !usdc
                ? { text: `USDC is not available on chain ${config.chainId}.` }
                : !account
                  ? { text: "Connect a wallet to donate." }
                  : null;

  // Allowance and balance must be known before the form can pick approve or donate.
  const fundsBlocker: Blocker | null =
    blocker || funds.data
      ? null
      : funds.error
        ? { text: `Could not read your USDC balance and allowance: ${errorText(funds.error)}`, alert: true, retry: () => void refetch() }
        : { text: "Reading your USDC balance and allowance" };

  const override = approved && sameAddress(approved.owner, account) && sameAddress(approved.vault, vaultAddress) ? approved.amount : null;
  const allowance = funds.data ? (override !== null && override > funds.data.allowance ? override : funds.data.allowance) : undefined;
  const parsed = parseUsdcInput(amount);
  // Unknown allowance is not "short": the button only offers approve once the allowance is read.
  const approval = parsed.ok && allowance !== undefined && needsApproval(allowance, parsed.amount);
  const awaiting = (tx: typeof approveTx) => Boolean(tx.hash && !tx.receipt && !tx.receiptError);
  const busy = approveTx.isPending || donateTx.isPending || awaiting(approveTx) || awaiting(donateTx);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (blocker || fundsBlocker || busy || !usdc || !vaultAddress || !funds.data || allowance === undefined) return;
    const p = parseUsdcInput(amount);
    if (!p.ok) return setFormError(p.error);
    const balance = funds.data.balance;
    if (balance < p.amount) return setFormError(`Your USDC balance (${usdcText(balance)}) is less than ${usdcText(p.amount)}`);
    if (needsApproval(allowance, p.amount)) {
      donateTx.reset();
      const wanted = p.amount;
      const owner = account!;
      const spender = vaultAddress;
      void approveTx
        .send(approveRequest({ usdc, vault: spender, amount: wanted, chainId: config.chainId }))
        .then((hash) => setApproving({ hash, amount: wanted, owner, vault: spender }))
        .catch(() => {});
      return;
    }
    setSentCredit(credit);
    void donateTx.send(donateRequest({ vault: vaultAddress, amount: p.amount, credit, chainId: config.chainId })).catch(() => {});
  }

  const shown = blocker ?? fundsBlocker;
  return (
    <section aria-label="Donate">
      <h2>Donate</h2>
      <p>
        Donations go to the agent&apos;s vault in USDC, and the agent gives them to the charities it ranks. Two steps: approve the
        vault to take the amount, then donate.
      </p>
      <form onSubmit={onSubmit} aria-label="Donate to the agent" noValidate>
        <p>
          <label>
            Amount (USDC){" "}
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              name="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={Boolean(blocker)}
            />
          </label>
        </p>
        <p>
          <label>
            <input type="checkbox" name="credit" checked={credit} onChange={(e) => setCredit(e.target.checked)} disabled={Boolean(blocker)} /> Credit me
            publicly
          </label>
        </p>
        <p>
          Unchecked, the donation is anonymous on this site: your address is never listed here. It is still visible on chain, like any
          transaction.
        </p>
        {funds.data && <p>Your USDC balance: {usdcText(funds.data.balance)}</p>}
        <button type="submit" disabled={Boolean(blocker) || Boolean(fundsBlocker) || busy}>
          {approval ? `Approve ${usdcText(parsed.amount)}` : parsed.ok ? `Donate ${usdcText(parsed.amount)}` : "Donate"}
        </button>
        {shown && (
          <p role={shown.alert ? "alert" : "note"}>
            {shown.text}
            {shown.retry && (
              <>
                {" "}
                <button type="button" onClick={shown.retry}>
                  Retry
                </button>
              </>
            )}
          </p>
        )}
        {formError && <p role="alert">{formError}</p>}
        <TxStatus tx={approveTx} label="Approval" />
        {approveTx.receipt?.status === "success" && !donateTx.hash && <p role="status">Approved. Now donate to complete the gift.</p>}
        <TxStatus tx={donateTx} label="Donation" />
        {donateTx.receipt?.status === "success" && (
          <p role="status">
            Thank you. {sentCredit ? "Your address will be listed as a credited donor once the indexer sees the donation." : "Your donation is anonymous on this site."}
          </p>
        )}
      </form>
    </section>
  );
}
