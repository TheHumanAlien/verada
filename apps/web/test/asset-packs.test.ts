import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/assets.generated", () => ({
  ASSETS: {},
  PACKS: {
    stocks: {
      NVDAon: { width: 512, height: 512, webp: [64, 128] },
      SPYon: { vector: true },
    },
  },
}));

const { packFileUrl, packImage, stockLogo } = await import("../src/lib/asset-packs");
const { envDefaults, mergeRuntimeConfig } = await import("../src/lib/config");

const REF = "a".repeat(64);
const cfg = { swarmGatewayUrl: "https://gw.example", assetPacks: { stocks: REF } };

describe("asset packs", () => {
  it("builds gateway URLs for a published pack", () => {
    expect(packFileUrl(cfg, "stocks", "index.json")).toBe(`https://gw.example/bzz/${REF}/index.json`);
  });

  it("returns nothing until the pack and gateway are configured", () => {
    expect(packFileUrl({ swarmGatewayUrl: "https://gw.example", assetPacks: {} }, "stocks", "x")).toBeUndefined();
    expect(packFileUrl({ swarmGatewayUrl: undefined, assetPacks: { stocks: REF } }, "stocks", "x")).toBeUndefined();
    expect(stockLogo({ swarmGatewayUrl: "https://gw.example", assetPacks: {} }, "NVDAon")).toBeUndefined();
  });

  it("picks the smallest raster that covers the display width, with a srcset", () => {
    const img = stockLogo(cfg, "NVDAon", 32)!;
    expect(img.src).toBe(`https://gw.example/bzz/${REF}/NVDAon-64.webp`);
    expect(img.srcSet).toBe(`https://gw.example/bzz/${REF}/NVDAon-64.webp 64w, https://gw.example/bzz/${REF}/NVDAon-128.webp 128w`);
    expect(img).toMatchObject({ width: 512, height: 512 });
    expect(packImage(cfg, "stocks", "NVDAon", 200)!.src).toBe(`https://gw.example/bzz/${REF}/NVDAon-128.webp`);
  });

  it("serves vectors as they are and skips unknown names", () => {
    expect(stockLogo(cfg, "SPYon")).toEqual({ src: `https://gw.example/bzz/${REF}/SPYon.svg` });
    expect(stockLogo(cfg, "TSLAon")).toBeUndefined();
    expect(stockLogo(cfg, "constructor")).toBeUndefined();
  });

  it("reads the pack reference from config.json and ignores invalid ones", () => {
    const base = { ...envDefaults(), assetPacks: {} };
    expect(mergeRuntimeConfig(base, { assetPacks: { stocks: `0x${REF}` } }).assetPacks.stocks).toBe(REF);
    expect(mergeRuntimeConfig(base, { assetPacks: { stocks: "nope" } })).toBe(base);
  });
});
