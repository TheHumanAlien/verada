/**
 * Pure helpers for donating USDC to a curator agent's `AgentVault`: input parsing and contract call
 * shapes for wagmi (`writeContract` / `useReadContract`). Two transactions: `USDC.approve(vault,
 * amount)`, then `AgentVault.donate(amount, credit)`. `credit: true` publicly credits the donor's
 * address (opt-in); otherwise the donation is anonymous and the app never shows its address.
 */
import { erc20Abi, type Address } from "viem";
import { CHAIN_ID, SETTLEMENT_ASSET, USDC_DECIMALS } from "@verada/sdk";
import { agentVaultAbi } from "@verada/sdk/abis";

/** Local anvil fork of mainnet: same USDC address. */
export const MAINNET_FORK_CHAIN_ID = 31337;

/** USDC on `chainId` (mainnet, or a local mainnet fork), or null where Verada has no deployment. */
export function usdcAddress(chainId: number): Address | null {
  return chainId === CHAIN_ID || chainId === MAINNET_FORK_CHAIN_ID ? SETTLEMENT_ASSET : null;
}

export type UsdcInput = { ok: true; amount: bigint } | { ok: false; error: string };

/**
 * Parses what a donor typed into USDC base units (6 decimals): plain digits with at most one
 * decimal point (`12`, `12.5`, `.5`, `12.`), at most 6 decimals, more than zero. Surrounding
 * whitespace is ignored; signs, exponents, separators and anything else are rejected.
 */
export function parseUsdcInput(value: string): UsdcInput {
  const v = value.trim();
  if (v === "" || v === ".") return { ok: false, error: "Enter an amount" };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m) return { ok: false, error: "Enter a number, like 25 or 12.50" };
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) return { ok: false, error: `USDC has at most ${USDC_DECIMALS} decimal places` };
  if (whole.length > 15) return { ok: false, error: "Amount is too large" };
  const amount = BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  if (amount <= 0n) return { ok: false, error: "Amount must be more than 0" };
  return { ok: true, amount };
}

/** True when the vault's current USDC allowance does not cover `amount`. */
export function needsApproval(allowance: bigint | undefined, amount: bigint): boolean {
  return allowance === undefined || allowance < amount;
}

/** `USDC.approve(vault, amount)`. */
export function approveRequest(p: { usdc: Address; vault: Address; amount: bigint; chainId: number }) {
  return {
    address: p.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [p.vault, p.amount],
    chainId: p.chainId,
  } as const;
}

/** `AgentVault.donate(amount, credit)`; pulls `amount` USDC from the sender (approve first). */
export function donateRequest(p: { vault: Address; amount: bigint; credit: boolean; chainId: number }) {
  return {
    address: p.vault,
    abi: agentVaultAbi,
    functionName: "donate",
    args: [p.amount, p.credit],
    chainId: p.chainId,
  } as const;
}

/** `USDC.allowance(owner, vault)`, for `useReadContract`. */
export function allowanceRequest(p: { usdc: Address; owner: Address; vault: Address; chainId: number }) {
  return {
    address: p.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [p.owner, p.vault],
    chainId: p.chainId,
  } as const;
}

/** `USDC.balanceOf(owner)`, for `useReadContract`. */
export function usdcBalanceRequest(p: { usdc: Address; owner: Address; chainId: number }) {
  return {
    address: p.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [p.owner],
    chainId: p.chainId,
  } as const;
}
