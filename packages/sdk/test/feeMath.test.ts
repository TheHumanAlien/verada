import { describe, expect, it } from "vitest";
import {
  PLATFORM_SHARE_BPS,
  USDC_DECIMALS,
  applyBps,
  bpsToV4Fee,
  endaomentFee,
  endaomentNet,
  formatUsdc,
  isValidBaseFeeBps,
  minOutForSlippage,
  parseUsdc,
  splitFees,
  splitUsdcFees,
} from "../src/feeMath.js";

describe("splitFees", () => {
  it("uses a 10% platform share", () => {
    expect(PLATFORM_SHARE_BPS).toBe(1000n);
    expect(splitFees(10_000n)).toEqual({ platform: 1_000n, cause: 9_000n });
  });

  it("rounds the platform share down so the cause pool gets the remainder", () => {
    expect(splitFees(1n)).toEqual({ platform: 0n, cause: 1n });
    expect(splitFees(9n)).toEqual({ platform: 0n, cause: 9n });
    expect(splitFees(19n)).toEqual({ platform: 1n, cause: 18n });
    expect(splitFees(0n)).toEqual({ platform: 0n, cause: 0n });
  });

  it("always sums to the input", () => {
    for (const amount of [0n, 1n, 7n, 99n, 12345n, 10n ** 30n + 17n, 2n ** 256n - 1n]) {
      const { platform, cause } = splitFees(amount);
      expect(platform + cause).toBe(amount);
      expect(cause >= platform || amount < 10n).toBe(true);
    }
  });

  it("rejects bad input", () => {
    expect(() => splitFees(-1n)).toThrow(RangeError);
    expect(() => splitFees(1n, 10_001n)).toThrow(RangeError);
  });
});

describe("fee helpers", () => {
  it("applyBps floors", () => {
    expect(applyBps(999n, 100)).toBe(9n);
  });
  it("validates base fee range", () => {
    expect(isValidBaseFeeBps(99)).toBe(false);
    expect(isValidBaseFeeBps(100)).toBe(true);
    expect(isValidBaseFeeBps(500)).toBe(true);
    expect(isValidBaseFeeBps(501)).toBe(false);
    expect(isValidBaseFeeBps(150.5)).toBe(false);
  });
  it("converts bps to v4 fee units", () => {
    expect(bpsToV4Fee(100)).toBe(10_000);
  });
});

describe("USDC settlement math", () => {
  it("parses and formats 6-decimal amounts", () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("7")).toBe(7_000_000n);
    expect(formatUsdc(12_500_000n)).toBe("12.5");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(7_000_000n)).toBe("7");
    expect(() => parseUsdc("1.0000001")).toThrow(RangeError);
    expect(() => parseUsdc("-1")).toThrow(RangeError);
    expect(() => formatUsdc(-1n)).toThrow(RangeError);
  });

  it("splits 100 USDC into 10 platform and 90 cause", () => {
    expect(splitUsdcFees(parseUsdc("100"))).toEqual({ platform: 10_000_000n, cause: 90_000_000n });
    expect(splitUsdcFees(9n)).toEqual({ platform: 0n, cause: 9n });
    expect(splitUsdcFees(10n)).toEqual({ platform: 1n, cause: 9n });
  });

  it("computes min-out for a slippage bound, rounding up", () => {
    expect(minOutForSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(minOutForSlippage(1n, 1)).toBe(1n);
    expect(minOutForSlippage(100n, 0)).toBe(100n);
    expect(() => minOutForSlippage(1n, 10_001)).toThrow(RangeError);
  });

  it("applies the Endaoment fee", () => {
    expect(endaomentFee(100_000_000n, 150)).toBe(1_500_000n);
    expect(endaomentNet(100_000_000n, 150)).toBe(98_500_000n);
    expect(endaomentFee(1n, 150)).toBe(0n);
    expect(() => endaomentFee(1n, 10_001)).toThrow(RangeError);
  });
});
