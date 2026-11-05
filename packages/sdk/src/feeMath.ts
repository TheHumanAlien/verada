/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;

/** Platform share of collected fees, in bps. The single source of truth for the split (10%). */
export const PLATFORM_SHARE_BPS = 1_000n;

/** Allowed per-token base pool fee range, in bps (1% to 5%). */
export const MIN_FEE_BPS = 100;
export const MAX_FEE_BPS = 500;

export interface FeeSplit {
  platform: bigint;
  cause: bigint;
}

/**
 * Splits `amount` between platform and cause pool.
 * The platform share rounds down, so any remainder goes to the cause pool.
 * Invariant: platform + cause === amount.
 */
export function splitFees(amount: bigint, platformShareBps: bigint = PLATFORM_SHARE_BPS): FeeSplit {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  if (platformShareBps < 0n || platformShareBps > BPS_DENOMINATOR) {
    throw new RangeError("platformShareBps out of range");
  }
  const platform = (amount * platformShareBps) / BPS_DENOMINATOR;
  return { platform, cause: amount - platform };
}

/** Applies a bps rate to an amount, rounding down. */
export function applyBps(amount: bigint, bps: bigint | number): bigint {
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Whether `feeBps` is an allowed base fee for a launched token. */
export function isValidBaseFeeBps(feeBps: number): boolean {
  return Number.isInteger(feeBps) && feeBps >= MIN_FEE_BPS && feeBps <= MAX_FEE_BPS;
}

/** Converts a bps fee into the Uniswap v4 hundredths-of-a-bip unit (1 bps = 100). */
export function bpsToV4Fee(feeBps: number): number {
  return feeBps * 100;
}

// ---------------------------------------------------------------------------
// Settlement-asset (USDC) accounting. All cause-pool and platform amounts are
// denominated in the settlement asset, which has 6 decimals.
// ---------------------------------------------------------------------------

/** Decimals of the settlement asset (USDC). */
export const USDC_DECIMALS = 6;

/** Endaoment fee denominator: fees are expressed in "zoc", where 10_000 is 100%. */
export const ENDAOMENT_FEE_DENOMINATOR = 10_000n;

/** Parses a decimal USDC string (e.g. "12.5") into base units (6 decimals). Excess precision is rejected. */
export function parseUsdc(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new RangeError(`invalid USDC amount: ${value}`);
  const frac = (m[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return BigInt(m[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac);
}

/** Formats USDC base units as a decimal string with trailing zeros trimmed. */
export function formatUsdc(amount: bigint): string {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = amount / unit;
  const frac = (amount % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Splits a consolidated USDC amount (6 decimals) 10/90 between platform and cause pool.
 * Same rounding as {@link splitFees}: the platform share rounds down.
 */
export function splitUsdcFees(usdcAmount: bigint, platformShareBps: bigint = PLATFORM_SHARE_BPS): FeeSplit {
  return splitFees(usdcAmount, platformShareBps);
}

/** Minimum acceptable output for a swap given a reference amount and a max slippage in bps (rounds up). */
export function minOutForSlippage(expectedOut: bigint, maxSlippageBps: bigint | number): bigint {
  const slip = BigInt(maxSlippageBps);
  if (expectedOut < 0n) throw new RangeError("expectedOut must be non-negative");
  if (slip < 0n || slip > BPS_DENOMINATOR) throw new RangeError("maxSlippageBps out of range");
  const num = expectedOut * (BPS_DENOMINATOR - slip);
  return (num + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

/**
 * Endaoment's fee on a donation of `amount` USDC, rounded down (matches the org contract).
 * `feeZoc` must be read on-chain via `registry.getDonationFee(org)`, never hardcoded.
 */
export function endaomentFee(amount: bigint, feeZoc: bigint | number): bigint {
  const fee = BigInt(feeZoc);
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  if (fee < 0n || fee > ENDAOMENT_FEE_DENOMINATOR) throw new RangeError("feeZoc out of range");
  return (amount * fee) / ENDAOMENT_FEE_DENOMINATOR;
}

/** Amount credited to the nonprofit after Endaoment's fee. */
export function endaomentNet(amount: bigint, feeZoc: bigint | number): bigint {
  return amount - endaomentFee(amount, feeZoc);
}
