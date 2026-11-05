"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { usePrivacyPrefs, usePrivateRpc } from "@/components/providers";

/**
 * Shows how this page reaches the chain, and lets the user choose what goes
 * through the anon network. The anon worker (Nym's is ~18 MB) starts on the first
 * chain read; once a wallet is connected, or Verada API routing is on, this panel
 * starts it straight away so the network bootstraps before it is needed.
 */
export function PrivacyStatus() {
  const rpc = usePrivateRpc();
  const [prefs, setPrefs] = usePrivacyPrefs();
  const { isConnected } = useAccount();
  const status = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.getStatus(),
    () => rpc.getStatus(),
  );
  const direct = useSyncExternalStore(
    (l) => rpc.subscribe(l),
    () => rpc.directPublicAllowed,
    () => false,
  );

  useEffect(() => {
    if (isConnected || prefs.routeIndexer) void rpc.start().catch(() => {});
  }, [rpc, isConnected, prefs.routeIndexer]);

  const net = rpc.network.label;
  let text: string;
  switch (status.state) {
    case "ready":
      text = rpc.network.anonymizes ? `Private RPC on: chain reads go through ${net}` : `RPC through ${net}: NOT anonymized`;
      break;
    case "failed":
      text = `Private RPC unavailable (${status.message}). Account data will not load until it reconnects.`;
      break;
    case "connecting":
      text = `Connecting to ${net}…`;
      break;
    default:
      text = `Private RPC (${net}) starts on the first chain read`;
  }

  return (
    <aside aria-label="Privacy">
      <p role="status">{text}</p>
      {status.state === "failed" && (
        <p>
          <button type="button" onClick={() => void rpc.retry().catch(() => {})}>
            Retry
          </button>{" "}
          {!direct && (
            <button type="button" onClick={() => rpc.allowDirectForPublic(true)}>
              Load public data directly (the RPC provider sees your IP; never used for account data)
            </button>
          )}
        </p>
      )}
      {direct && <p role="note">Public data is loading directly for this visit. Account data still only loads privately.</p>}
      <label>
        <input
          type="checkbox"
          checked={prefs.routeIndexer}
          onChange={(e) => setPrefs({ ...prefs, routeIndexer: e.target.checked })}
        />{" "}
        Also route Verada API requests through {net} (slower; Verada never sees your IP)
      </label>
    </aside>
  );
}
