/**
 * Anonymizing networks reachable through anon-rpc (https://github.com/ethereum/anon-rpc).
 *
 * Each entry is an on-chain IWorkerSpecifier contract that pins the anon-client
 * bundle by keccak256 hash. Addresses come from the project's adopters.json5.
 * All three specifiers live on Ethereum mainnet, which is where the harness's
 * one bootstrap read goes. That is the chain the specifier lives on, not a limit
 * on which RPCs the anonymized fetch can reach.
 */
export const ANON_NETWORKS = {
  nym: {
    label: "Nym mixnet",
    specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    anonymizes: true,
  },
  "tor-js": {
    label: "Tor",
    specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    anonymizes: true,
  },
  passthrough: {
    // Reference worker: exercises the sandbox and hash pinning only. Never use in production.
    label: "Passthrough (not anonymized)",
    specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    anonymizes: false,
  },
} as const satisfies Record<string, { label: string; specifier: string; anonymizes: boolean }>;

export type AnonNetworkId = keyof typeof ANON_NETWORKS;

export const ANON_NETWORK_IDS = Object.keys(ANON_NETWORKS) as AnonNetworkId[];

/** Chain every listed specifier is deployed on. The bootstrap RPC must serve this chain. */
export const SPECIFIER_CHAIN_ID = 1;

export function isAnonNetworkId(v: unknown): v is AnonNetworkId {
  return typeof v === "string" && Object.hasOwn(ANON_NETWORKS, v);
}
