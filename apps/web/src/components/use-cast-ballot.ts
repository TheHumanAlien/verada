"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useAppConfig, useDeps } from "@/components/providers";
import { useTx, errorText } from "@/components/use-tx";
import { lazyEncryptor, type Encryptor } from "@/lib/ballot";
import type { DataDeps } from "@/lib/data";
import { schemeContract, selectVoteAdapter, type VoteAdapter } from "@/lib/vote-adapter";

// One encryptor per data layer, so the FHE key fetched for the first ballot is reused afterwards.
const encryptors = new WeakMap<DataDeps, () => Promise<Encryptor>>();

export interface CastBallotArgs {
  governor: Address;
  token: Address;
  scope: bigint;
  choice: number;
  /** The poll's scheme; defaults to `votingSchemeAddress`. */
  scheme?: Address;
}

export type BallotPhase = "idle" | "encrypting" | "signing" | "sent" | "error";

/** Encrypt (or, in development, encode) a choice and send `castBallot` from the voter's wallet. */
export function useCastBallot(): {
  adapter: VoteAdapter;
  phase: BallotPhase;
  error?: string;
  tx: ReturnType<typeof useTx>;
  cast(args: CastBallotArgs): Promise<void>;
} {
  const config = useAppConfig();
  const deps = useDeps();
  const { address } = useAccount();
  const tx = useTx();
  const [phase, setPhase] = useState<BallotPhase>("idle");
  const [error, setError] = useState<string>();

  const adapter = useMemo(() => {
    let get = encryptors.get(deps);
    if (!get) {
      get = lazyEncryptor(() => ({ chainId: config.chainId, publicClient: deps.chain(), relayerUrl: config.zamaRelayerUrl }));
      encryptors.set(deps, get);
    }
    return selectVoteAdapter(config, get);
  }, [config, deps]);

  async function cast(args: CastBallotArgs) {
    setError(undefined);
    tx.reset();
    const scheme = args.scheme ?? config.votingSchemeAddress;
    if (!address) return fail("Connect a wallet to vote");
    if (!scheme) return fail("votingSchemeAddress is not configured (config.json)");
    try {
      setPhase("encrypting");
      const call = await adapter.buildCall({ ...args, scheme, voter: address });
      setPhase("signing");
      await tx.send({ ...schemeContract, address: scheme, ...call, chainId: config.chainId });
      setPhase("sent");
    } catch (e) {
      fail(errorText(e));
    }
  }

  function fail(message: string) {
    setError(message);
    setPhase("error");
  }

  return { adapter, phase, error, tx, cast };
}
