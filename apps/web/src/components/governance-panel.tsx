"use client";

import { useState, type FormEvent } from "react";
import { useReadContract, useWriteContract } from "wagmi";
import { useAppConfig } from "@/components/providers";
import { defaultVoteAdapter, governorContract, parseVoteRequest } from "@/lib/vote-adapter";

export function GovernancePanel() {
  const config = useAppConfig();
  const adapter = defaultVoteAdapter;
  const [token, setToken] = useState("");
  const [cause, setCause] = useState("");
  const [error, setError] = useState<string | undefined>();
  const governor = config.governorAddress;

  const epoch = useReadContract({
    ...governorContract,
    address: governor,
    functionName: "currentEpoch",
    chainId: config.chainId,
    query: { enabled: Boolean(governor) },
  });
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!governor) return setError("governorAddress is not configured (config.json)");
    const request = parseVoteRequest(token, cause);
    if (typeof request === "string") return setError(request);
    const call = await adapter.buildCall(request);
    writeContract({ ...governorContract, address: governor, ...call, chainId: config.chainId });
  }

  return (
    <div>
      <p>
        Current epoch:{" "}
        {!governor ? "governor not configured" : epoch.isLoading ? "loading" : epoch.data !== undefined ? String(epoch.data) : "unavailable"}
      </p>
      {adapter.placeholder && (
        <p role="note">
          PLACEHOLDER: voting is currently public and unverified. The private voting adapter will replace this.
        </p>
      )}
      <form onSubmit={onSubmit}>
        <p>
          <label>
            Token address <input value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
        </p>
        <p>
          <label>
            Cause (bytes32 id or org identifier) <input value={cause} onChange={(e) => setCause(e.target.value)} />
          </label>
        </p>
        <p>Adapter: {adapter.label}</p>
        <button type="submit" disabled={isPending}>
          {isPending ? "Confirm in wallet" : "Cast vote"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {writeError && <p role="alert">{writeError.message}</p>}
      {hash && <p>Transaction submitted: {hash}</p>}
    </div>
  );
}
