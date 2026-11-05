import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { envDefaults, loadRuntimeConfig, mergeRuntimeConfig } from "@/lib/config";

const addr = "0x00000000000000000000000000000000000000aa";

describe("runtime config", () => {
  it("merges config.json over defaults and strips trailing slashes", () => {
    const merged = mergeRuntimeConfig(envDefaults(), { indexerUrls: ["https://a.example/", "https://b.example"], factoryAddress: addr, factoryDeployBlock: 5 });
    expect(merged.indexerUrls).toEqual(["https://a.example", "https://b.example"]);
    expect(merged.factoryAddress).toBe(getAddress(addr));
    expect(merged.factoryDeployBlock).toBe(5n);
    expect(merged.chainId).toBe(1);
  });

  it("ignores an invalid file", () => {
    const d = envDefaults();
    expect(mergeRuntimeConfig(d, { indexerUrls: [] })).toBe(d);
    expect(mergeRuntimeConfig(d, { factoryAddress: "nope" })).toBe(d);
  });

  it("loads relative to the site base and falls back on failure", async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ indexerUrls: ["https://x.example"] }) });
    const cfg = await loadRuntimeConfig(ok as unknown as typeof fetch, "/bzz/abc/");
    expect(ok.mock.calls[0]?.[0]).toBe("/bzz/abc/config.json");
    expect(cfg.indexerUrls).toEqual(["https://x.example"]);
    const bad = vi.fn().mockRejectedValue(new Error("down"));
    expect((await loadRuntimeConfig(bad as unknown as typeof fetch, "/")).indexerUrls).toEqual(envDefaults().indexerUrls);
  });
});
