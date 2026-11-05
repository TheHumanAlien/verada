"use client";

import { useState, type FormEvent } from "react";
import { useWriteContract } from "wagmi";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS } from "@verada/sdk";
import { factoryAbi } from "@/lib/abis";
import { useAppConfig } from "@/components/providers";
import { MAX_FEE_BPS, MIN_FEE_BPS, parseLaunchInput, type LaunchInput } from "@/lib/launch";

const initial: LaunchInput = {
  name: "",
  symbol: "",
  metadataURI: "",
  salt: "",
  baseFeeBps: String(MIN_FEE_BPS),
  sniperFeeStartBps: "0",
  sniperDecaySeconds: "0",
  startTick: "0",
  quoteAsset: EXTERNAL_ADDRESSES.weth,
};

// Suggested quote assets; the factory still rejects anything not allowlisted on-chain.
const QUOTE_OPTIONS: { label: string; address: string }[] = [
  { label: "WETH", address: EXTERNAL_ADDRESSES.weth },
  ...(["NVDAon", "TSLAon", "SPYon", "QQQon"] as const).map((k) => ({
    label: k,
    address: ONDO_TOKENS[k].address,
  })),
];

export function LaunchForm() {
  const config = useAppConfig();
  const [input, setInput] = useState<LaunchInput>(initial);
  const [error, setError] = useState<string | undefined>();
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();

  const set = (key: keyof LaunchInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setInput((prev) => ({ ...prev, [key]: e.target.value }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!config.factoryAddress) return setError("factoryAddress is not configured (config.json)");
    const parsed = parseLaunchInput(input);
    if (!parsed.ok) return setError(parsed.error);
    writeContract({
      address: config.factoryAddress,
      abi: factoryAbi,
      functionName: "deployToken",
      args: [parsed.params],
      chainId: config.chainId,
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <p>
        <label>
          Name <input value={input.name} onChange={set("name")} />
        </label>
      </p>
      <p>
        <label>
          Symbol <input value={input.symbol} onChange={set("symbol")} />
        </label>
      </p>
      <p>
        <label>
          Metadata URI <input value={input.metadataURI} onChange={set("metadataURI")} />
        </label>
      </p>
      <p>
        <label>
          Base fee (bps, {MIN_FEE_BPS} to {MAX_FEE_BPS}){" "}
          <input value={input.baseFeeBps} onChange={set("baseFeeBps")} inputMode="numeric" />
        </label>
      </p>
      <p>
        <label>
          Sniper fee start (bps) <input value={input.sniperFeeStartBps} onChange={set("sniperFeeStartBps")} inputMode="numeric" />
        </label>
      </p>
      <p>
        <label>
          Sniper decay (seconds) <input value={input.sniperDecaySeconds} onChange={set("sniperDecaySeconds")} inputMode="numeric" />
        </label>
      </p>
      <p>
        <label>
          Start tick <input value={input.startTick} onChange={set("startTick")} inputMode="numeric" />
        </label>
      </p>
      <p>
        <label>
          Quote asset{" "}
          <select value={input.quoteAsset} onChange={set("quoteAsset")}>
            {QUOTE_OPTIONS.map((o) => (
              <option key={o.address} value={o.address}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          Salt (optional, 32-byte hex) <input value={input.salt} onChange={set("salt")} />
        </label>
      </p>
      <button type="submit" disabled={isPending}>
        {isPending ? "Confirm in wallet" : "Launch token"}
      </button>
      {error && <p role="alert">{error}</p>}
      {writeError && <p role="alert">{writeError.message}</p>}
      {hash && <p>Transaction submitted: {hash}</p>}
    </form>
  );
}
