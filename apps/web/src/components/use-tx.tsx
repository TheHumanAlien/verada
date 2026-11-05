"use client";

import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import type { Hex, TransactionReceipt } from "viem";
import { useAppConfig } from "@/components/providers";

/** A wallet write plus its receipt (receipts are read through the private RPC under the account's key). */
export function useTx() {
  const config = useAppConfig();
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, chainId: config.chainId, query: { enabled: Boolean(hash) } });
  return { send: writeContractAsync, hash, isPending, error, receipt: receipt.data, receiptError: receipt.error, reset };
}

export type Tx = ReturnType<typeof useTx>;

export function errorText(e: unknown): string {
  if (!e) return "";
  const err = e as { shortMessage?: unknown; message?: unknown };
  if (typeof err.shortMessage === "string") return err.shortMessage;
  if (typeof err.message === "string") return err.message.split("\n")[0] ?? err.message;
  return String(e);
}

export function TxStatus({ tx, label = "Transaction" }: { tx: Pick<Tx, "hash" | "isPending" | "error" | "receipt" | "receiptError">; label?: string }) {
  return (
    <>
      {tx.isPending && <p role="status">Confirm in your wallet</p>}
      {tx.error && <p role="alert">{errorText(tx.error)}</p>}
      {tx.hash && !tx.receipt && !tx.receiptError && <p role="status">{label} submitted: {tx.hash}. Waiting for confirmation</p>}
      {tx.receiptError && <p role="alert">Could not read the receipt: {errorText(tx.receiptError)}</p>}
      {tx.receipt && <ReceiptLine receipt={tx.receipt} hash={tx.hash} label={label} />}
    </>
  );
}

function ReceiptLine({ receipt, hash, label }: { receipt: TransactionReceipt; hash?: Hex; label: string }) {
  return receipt.status === "success" ? (
    <p role="status">{label} confirmed in block {String(receipt.blockNumber)} ({hash})</p>
  ) : (
    <p role="alert">{label} reverted ({hash})</p>
  );
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return "none";
  return a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

/** UTC timestamp, so output does not depend on the viewer's locale. */
export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined) return "unknown";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
