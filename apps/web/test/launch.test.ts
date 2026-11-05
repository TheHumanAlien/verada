import { describe, expect, it } from "vitest";
import { buildMetadataDocument, EMPTY_METADATA_FIELDS, parseLaunchInput, ZERO_LOGO_REF, type LaunchInput } from "@/lib/launch";

const REF = "ab".repeat(32);

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
  label: "verada-test",
  logoRef: "",
  categories: [],
  regions: [],
};

describe("parseLaunchInput", () => {
  it("accepts valid input and generates a salt", () => {
    const r = parseLaunchInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.params.baseFeeBps).toBe(300);
      expect(r.params.startTick).toBe(-100);
      // No focus ticked: any cause, any region.
      expect(r.params.categoryMask).toBe((1n << 21n) - 1n);
      expect(r.params.regionMask).toBe(0xff);
    }
  });

  it("encodes the cause focus as masks and rejects unknown slugs", () => {
    const r = parseLaunchInput({ ...valid, categories: ["hunger", "children-youth"], regions: ["africa"] });
    expect(r.ok && r.params.categoryMask).toBe(12n);
    expect(r.ok && r.params.regionMask).toBe(1);
    expect(parseLaunchInput({ ...valid, categories: ["nope"] }).ok).toBe(false);
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

describe("parseLaunchInput label and logo", () => {
  it("passes the label through and defaults the logo to the zero reference", () => {
    const r = parseLaunchInput(valid);
    expect(r.ok && r.params.label).toBe("verada-test");
    expect(r.ok && r.params.logoRef).toBe(ZERO_LOGO_REF);
  });

  it("rejects labels the registry would reject", () => {
    for (const label of ["", "ab", "-abc", "abc-", "Has-Caps", "ab--cd", "a".repeat(64), "with space"]) {
      expect(parseLaunchInput({ ...valid, label }).ok, label).toBe(false);
    }
  });

  it("turns a Swarm reference into the bytes32 logo ref and rejects bad ones", () => {
    for (const logoRef of [REF, `0x${REF}`, `bzz://${REF}`]) {
      const r = parseLaunchInput({ ...valid, logoRef });
      expect(r.ok && r.params.logoRef).toBe(`0x${REF}`);
    }
    expect(parseLaunchInput({ ...valid, logoRef: "1234" }).ok).toBe(false);
    // Encrypted references must never land on-chain.
    expect(parseLaunchInput({ ...valid, logoRef: "cd".repeat(64) }).ok).toBe(false);
  });
});

describe("buildMetadataDocument", () => {
  const token = { name: "Verada Test", symbol: "VT" };

  it("builds the publisher document with only the fields that are set", () => {
    const r = buildMetadataDocument(token, `0x${REF.toUpperCase()}`, { ...EMPTY_METADATA_FIELDS, website: "https://verada.example", twitter: "@verada" });
    expect(r).toEqual({ ok: true, doc: { name: "Verada Test", symbol: "VT", logoRef: REF, website: "https://verada.example", twitter: "verada" } });
  });

  it("never includes an address field", () => {
    const r = buildMetadataDocument(token, REF, { description: "d", website: "https://x.example", twitter: "t", telegram: "g", discord: "https://discord.gg/x" });
    expect(r.ok && Object.keys(r.doc).sort()).toEqual(["description", "discord", "logoRef", "name", "symbol", "telegram", "twitter", "website"]);
  });

  it("applies the publisher's limits", () => {
    expect(buildMetadataDocument(token, "", EMPTY_METADATA_FIELDS).ok).toBe(false);
    expect(buildMetadataDocument({ ...token, symbol: "BAD SYMBOL" }, REF, EMPTY_METADATA_FIELDS).ok).toBe(false);
    expect(buildMetadataDocument(token, REF, { ...EMPTY_METADATA_FIELDS, website: "ftp://x" }).ok).toBe(false);
    expect(buildMetadataDocument(token, REF, { ...EMPTY_METADATA_FIELDS, telegram: "has space" }).ok).toBe(false);
    expect(buildMetadataDocument(token, REF, { ...EMPTY_METADATA_FIELDS, description: "x".repeat(2001) }).ok).toBe(false);
  });
});
