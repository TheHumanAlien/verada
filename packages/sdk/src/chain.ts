import type { Chain } from "viem";
import { mainnet } from "viem/chains";

/** Verada runs on Ethereum mainnet only. */
export const CHAIN_ID = 1 as const;
export const chain: Chain = mainnet;
export type VeradaChainId = typeof CHAIN_ID;
