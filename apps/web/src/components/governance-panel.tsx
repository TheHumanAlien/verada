"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { isAddress } from "viem";
import { useRel } from "@/components/nav";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { loadCurrentEpoch } from "@/lib/data";

/** Epoch overview. Ballots are cast per token, on the token's page. */
export function GovernancePanel() {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();

  const epoch = useQuery({
    queryKey: ["current-epoch"],
    queryFn: () => loadCurrentEpoch(config, deps),
    enabled: Boolean(config.governorAddress),
    retry: false,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = token.trim();
    if (!isAddress(v)) return setError("Token must be a valid address");
    window.location.href = rel(`token/?address=${v}`);
  }

  return (
    <div>
      <p>
        Current epoch:{" "}
        {!config.governorAddress
          ? "governor not configured"
          : epoch.isLoading
            ? "loading"
            : epoch.data !== undefined
              ? String(epoch.data)
              : `unavailable${epoch.error ? ` (${errorText(epoch.error)})` : ""}`}
      </p>
      <p>
        Each week, holders of a token vote with an encrypted ballot on which charity receives that token&apos;s cause pool. The
        ballot holds up to 32 charities from the token&apos;s cause focus: any the token&apos;s controller pinned, and the rest drawn
        in rotation from every matching charity in the catalogue. Only totals are decrypted after the epoch ends. Vote from a
        token&apos;s page.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          Token address <input value={token} onChange={(e) => setToken(e.target.value)} />
        </label>{" "}
        <button type="submit">Open token page</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
