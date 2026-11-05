import { getAddress, isAddress, isHex, toHex, type Address, type Hex } from "viem";
import { EXTERNAL_ADDRESSES } from "@verada/sdk";

// Fee bounds mirror the contract constants MIN_FEE_BPS / MAX_FEE_BPS.
export const MIN_FEE_BPS = 100;
export const MAX_FEE_BPS = 500;

export interface LaunchInput {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: string;
  baseFeeBps: string;
  sniperFeeStartBps: string;
  sniperDecaySeconds: string;
  startTick: string;
  /** Quote asset address; must be allowlisted in the on-chain quote registry. */
  quoteAsset: string;
}

export interface DeployParams {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: Hex;
  baseFeeBps: number;
  sniperFeeStartBps: number;
  sniperDecaySeconds: number;
  startTick: number;
  quoteAsset: Address;
}

export type ParseResult = { ok: true; params: DeployParams } | { ok: false; error: string };

function int(value: string, label: string, min: number, max: number): number | string {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n)) return `${label} must be an integer`;
  if (n < min || n > max) return `${label} must be between ${min} and ${max}`;
  return n;
}

export function parseLaunchInput(input: LaunchInput): ParseResult {
  if (!input.name.trim()) return { ok: false, error: "Name is required" };
  if (!input.symbol.trim()) return { ok: false, error: "Symbol is required" };

  const baseFeeBps = int(input.baseFeeBps, "Base fee (bps)", MIN_FEE_BPS, MAX_FEE_BPS);
  if (typeof baseFeeBps === "string") return { ok: false, error: baseFeeBps };
  // Anti-sniper surcharge starts at most 80% (8000 bps).
  const sniperFeeStartBps = int(input.sniperFeeStartBps, "Sniper fee start (bps)", 0, 8000);
  if (typeof sniperFeeStartBps === "string") return { ok: false, error: sniperFeeStartBps };
  const sniperDecaySeconds = int(input.sniperDecaySeconds, "Sniper decay (seconds)", 0, 2 ** 32 - 1);
  if (typeof sniperDecaySeconds === "string") return { ok: false, error: sniperDecaySeconds };
  const startTick = int(input.startTick, "Start tick", -887272, 887272);
  if (typeof startTick === "string") return { ok: false, error: startTick };

  const quote = input.quoteAsset.trim() === "" ? EXTERNAL_ADDRESSES.weth : input.quoteAsset.trim();
  if (!isAddress(quote, { strict: false })) return { ok: false, error: "Quote asset must be an address" };

  const salt = input.salt.trim();
  if (salt !== "" && !(isHex(salt) && salt.length === 66)) {
    return { ok: false, error: "Salt must be empty or a 32-byte hex string" };
  }

  return {
    ok: true,
    params: {
      name: input.name.trim(),
      symbol: input.symbol.trim(),
      metadataURI: input.metadataURI.trim(),
      salt: salt === "" ? randomSalt() : (salt as Hex),
      baseFeeBps,
      sniperFeeStartBps,
      sniperDecaySeconds,
      startTick,
      quoteAsset: getAddress(quote.toLowerCase()),
    },
  };
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
