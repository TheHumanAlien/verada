import { createClient } from "@1claw/sdk";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

/** Signs and sends a curator agent's transactions and messages. The key never leaves the signer. */
export interface CuratorSigner {
  address(): Promise<Address>;
  /** Sends `data` to `to` (no value) on Ethereum mainnet; resolves with the transaction hash. */
  send(to: Address, data: Hex): Promise<Hex>;
  /** EIP-191 personal_sign of `message` (a hex string). */
  signMessage(message: Hex): Promise<Hex>;
}

export interface OneClawOptions {
  baseUrl?: string;
  /** Agent API key. In scheduled tasks it is a network secret injected by the proxy; pass a placeholder then. */
  apiKey: string;
  agentId: string;
  chain?: string;
}

/**
 * 1Claw Intents signer: the agent's key lives in 1Claw's HSM; every call is subject to the agent's
 * 1Claw policies (`tx_to_allowlist`, caps, simulation, approval thresholds).
 */
export function oneClawSigner(o: OneClawOptions, client = createClient({ baseUrl: o.baseUrl ?? "https://api.1claw.co", apiKey: o.apiKey, agentId: o.agentId })): CuratorSigner {
  const chain = o.chain ?? "ethereum";
  let from: Address | undefined;
  const unwrap = <T>(r: { data?: T | null; error?: { message?: string } | null }, what: string): T => {
    if (!r.data) throw new Error(`1Claw ${what} failed: ${r.error?.message ?? "no data"}`);
    return r.data;
  };
  return {
    async address() {
      if (from) return from;
      const r = unwrap(await client.agents.sign(o.agentId, { intent_type: "personal_sign", chain, message: "verada-curator address probe" }), "sign");
      from = r.from as Address;
      return from;
    },
    async send(to, data) {
      const r = unwrap(await client.agents.submitTransaction(o.agentId, { to, value: "0", chain, data, simulate_first: true }), "submitTransaction");
      const hash = (r as { tx_hash?: string }).tx_hash;
      if (!hash) throw new Error(`1Claw transaction not broadcast (status ${(r as { status?: string }).status ?? "unknown"})`);
      return hash as Hex;
    },
    async signMessage(message) {
      const r = unwrap(await client.agents.sign(o.agentId, { intent_type: "personal_sign", chain, message }), "sign");
      if (!r.signature) throw new Error("1Claw returned no signature");
      return r.signature as Hex;
    },
  };
}

/** Local private-key signer for development and fork tests only. */
export function localKeySigner(privateKey: Hex, rpcUrl: string): CuratorSigner {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });
  return {
    address: async () => account.address,
    send: (to, data) => wallet.sendTransaction({ to, data, value: 0n }),
    signMessage: (message) => account.signMessage({ message: { raw: message } }),
  };
}
