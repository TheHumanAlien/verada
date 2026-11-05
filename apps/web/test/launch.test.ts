import { describe, expect, it } from "vitest";
import { parseLaunchInput, type LaunchInput } from "@/lib/launch";

const valid: LaunchInput = {
  name: "Verada Test",
  symbol: "VT",
  metadataURI: "ipfs://x",
  salt: "",
  baseFeeBps: "300",
  sniperFeeStartBps: "5000",
  sniperDecaySeconds: "60",
  startTick: "-100",
  quoteAsset: "",
};

describe("parseLaunchInput", () => {
  it("accepts valid input and generates a salt", () => {
    const r = parseLaunchInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.params.baseFeeBps).toBe(300);
      expect(r.params.startTick).toBe(-100);
    }
  });

  it("defaults the quote asset to WETH and rejects non-addresses", () => {
    const r = parseLaunchInput(valid);
    if (r.ok) expect(r.params.quoteAsset).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(parseLaunchInput({ ...valid, quoteAsset: "nope" }).ok).toBe(false);
  });

  it("rejects fees outside 100..500 bps", () => {
    expect(parseLaunchInput({ ...valid, baseFeeBps: "99" }).ok).toBe(false);
    expect(parseLaunchInput({ ...valid, baseFeeBps: "501" }).ok).toBe(false);
  });

  it("rejects a malformed salt and an empty name", () => {
    expect(parseLaunchInput({ ...valid, salt: "0x12" }).ok).toBe(false);
    expect(parseLaunchInput({ ...valid, name: " " }).ok).toBe(false);
  });
});
