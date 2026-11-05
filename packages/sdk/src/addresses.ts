import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { CHAIN_ID } from "./chain.js";

/** Third-party mainnet contracts, verified against official docs. */
export const EXTERNAL_ADDRESSES = {
  weth: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  poolManager: getAddress("0x000000000004444c5dc75cB358380D2e3dE08A90"),
  positionManager: getAddress("0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e"),
  stateView: getAddress("0x7ffe42c4a5deea5b0fec41c94c136cf115597227"),
  quoter: getAddress("0x99bd42B2B22e531f283b7F8a86dFf631EB16A9D1"),
  universalRouter: getAddress("0x66a9893cc07d91d95644aedd05d03f95e1dba8af"),
  endaomentRegistry: getAddress("0x94106ca9c7e567109a1d39413052887d1f412183"),
  endaomentOrgFundFactory: getAddress("0x10fd9348136dcea154f752fe0b6db45fc298a589"),
  /** Endaoment fee recipient, read from `registry.treasury()`. */
  endaomentTreasury: getAddress("0xd7d78Cf2f7c5a1B2E44080814D2f54a41A151A37"),
} as const satisfies Record<string, Address>;

/**
 * ENSv2 mainnet contracts (docs.ens.domains/learn/deployments, verified on-chain 2026-11-05).
 * The Universal Resolver address is the canonical proxy, which stays stable across upgrades.
 */
export const ENS_V2_ADDRESSES = {
  ethRegistry: getAddress("0xf60aba43e1f7f3dab1186ff03b561401c9df85e2"),
  ethRegistrar: getAddress("0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81"),
  universalResolver: getAddress("0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe"),
} as const satisfies Record<string, Address>;

/**
 * Zama FHEVM protocol contracts on Ethereum mainnet, copied from `@fhevm/solidity` 0.13.4
 * `config/ZamaConfig.sol` (`getEthereumCoprocessorConfig`, chain id 1).
 */
export const ZAMA_ADDRESSES = {
  acl: getAddress("0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6"),
  coprocessor: getAddress("0xD82385dADa1ae3E969447f20A3164F6213100e75"),
  kmsVerifier: getAddress("0x77627828a55156b04Ac0DC0eb30467f1a552BB03"),
} as const satisfies Record<string, Address>;

/**
 * Settlement asset: the single asset the cause pool and platform share are held in.
 * USDC is the only asset an Endaoment org accepts natively.
 */
export const SETTLEMENT_ASSET = EXTERNAL_ADDRESSES.usdc;

export const DEPLOYMENT_KEYS = [
  "factory",
  "hook",
  "lpLocker",
  "feeVault",
  "causeRegistry",
  "causeCatalog",
  "epochGovernor",
  "donationDistributor",
  "quoteRegistry",
  "feeConsolidator",
  "profileRegistry",
  "resolver",
  "takeoverGovernor",
  "votingScheme",
] as const;

export type DeploymentKey = (typeof DEPLOYMENT_KEYS)[number];

export interface VeradaDeployment extends Record<DeploymentKey, Address> {
  chainId: typeof CHAIN_ID;
  /** Block at which the factory was deployed (0 until deployed). */
  deployBlock: bigint;
}

/** Placeholder deployment: all Verada contracts are the zero address until deploy. */
export const PLACEHOLDER_DEPLOYMENT: VeradaDeployment = {
  chainId: CHAIN_ID,
  deployBlock: 0n,
  factory: zeroAddress,
  hook: zeroAddress,
  lpLocker: zeroAddress,
  feeVault: zeroAddress,
  causeRegistry: zeroAddress,
  causeCatalog: zeroAddress,
  epochGovernor: zeroAddress,
  donationDistributor: zeroAddress,
  quoteRegistry: zeroAddress,
  feeConsolidator: zeroAddress,
  profileRegistry: zeroAddress,
  resolver: zeroAddress,
  takeoverGovernor: zeroAddress,
  votingScheme: zeroAddress,
};

export const mainnetDeployment: VeradaDeployment = PLACEHOLDER_DEPLOYMENT;

export function isDeployed(deployment: VeradaDeployment): boolean {
  return DEPLOYMENT_KEYS.every((k) => deployment[k] !== zeroAddress);
}

/**
 * Validates and normalizes an untyped deployment record (e.g. parsed JSON).
 * Addresses are checksummed; missing or malformed fields throw.
 */
export function loadDeployment(input: unknown): VeradaDeployment {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("deployment must be an object");
  }
  const rec = input as Record<string, unknown>;
  if (rec.chainId !== CHAIN_ID) {
    throw new Error(`deployment chainId must be ${CHAIN_ID}`);
  }
  const out = { ...PLACEHOLDER_DEPLOYMENT };
  for (const key of DEPLOYMENT_KEYS) {
    const value = rec[key];
    if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new Error(`deployment.${key} is not a valid address`);
    }
    out[key] = getAddress(value);
  }
  if (rec.deployBlock !== undefined) {
    const block = BigInt(rec.deployBlock as string | number | bigint);
    if (block < 0n) throw new RangeError("deployment.deployBlock must be non-negative");
    out.deployBlock = block;
  }
  return out;
}
