import { describe, expect, it } from "vitest";
import { EXTERNAL_ADDRESSES, SETTLEMENT_ASSET } from "../src/addresses.js";
import { ONDO_INFRA, ONDO_TOKENS, isOndoToken, ondoSymbolOf } from "../src/ondo.js";

describe("ondo constants", () => {
  it("has unique token addresses", () => {
    const addrs = Object.values(ONDO_TOKENS).map((t) => t.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(addrs.length).toBeGreaterThan(400);
  });
  it("looks up by address, case-insensitively", () => {
    expect(ondoSymbolOf(ONDO_TOKENS.AAPLon.address.toLowerCase())).toBe("AAPLon");
    expect(isOndoToken(ONDO_TOKENS.USDon.address)).toBe(true);
    expect(isOndoToken(EXTERNAL_ADDRESSES.weth)).toBe(false);
  });
  it("settles in USDC and exposes the pause manager", () => {
    expect(SETTLEMENT_ASSET).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(ONDO_INFRA.tokenPauseManager).toBe("0xfD48112E448417CA79305a518c4186dF4b0A200a");
  });
});
