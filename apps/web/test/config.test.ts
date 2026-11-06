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

describe("private RPC config", () => {
  it("defaults to Nym and follows a runtime rpcUrl", () => {
    const d = envDefaults();
    expect(d.privateRpc.network).toBe("nym");
    expect(d.privateRpc.rpcUrls.length).toBeGreaterThan(0);
    const m = mergeRuntimeConfig(d, { rpcUrl: "https://my-rpc.example" });
    expect(m.privateRpc.rpcUrls[0]).toBe("https://my-rpc.example");
    expect(m.privateRpc.rpcUrls.length).toBeGreaterThan(1);
  });

  it("accepts a network, failover list and worker config", () => {
    const m = mergeRuntimeConfig(envDefaults(), {
      privateRpc: { network: "tor-js", rpcUrls: ["https://a.example/", "https://b.example"], workerConfig: { gateways: ["g"] } },
    });
    expect(m.privateRpc).toMatchObject({ network: "tor-js", rpcUrls: ["https://a.example", "https://b.example"], workerConfig: { gateways: ["g"] } });
  });

  it("rejects an unknown network", () => {
    const d = envDefaults();
    expect(mergeRuntimeConfig(d, { privateRpc: { network: "carrier-pigeon" } })).toBe(d);
  });
});

describe("profile, publisher and voting config", () => {
  it("defaults the ENS parent and leaves the new addresses unset", () => {
    const d = envDefaults();
    expect(d.ensParentName).toBe("varada.eth");
    expect(d.publisherUrl).toBeUndefined();
    expect(d.votingSchemeAddress).toBeUndefined();
    expect(d.curatorRegistryAddress).toBeUndefined();
    expect(d.devPlainBallots).toBe(false);
  });

  it("merges the new keys", () => {
    const m = mergeRuntimeConfig(envDefaults(), {
      publisherUrl: "https://publisher.example/",
      swarmGatewayUrl: "https://gw.example",
      ensParentName: "Example.ETH",
      profileRegistryAddress: addr,
      votingSchemeAddress: addr,
      takeoverGovernorAddress: addr,
      curatorRegistryAddress: addr,
      zamaRelayerUrl: "https://relayer.example/",
    });
    expect(m).toMatchObject({
      publisherUrl: "https://publisher.example",
      swarmGatewayUrl: "https://gw.example",
      ensParentName: "example.eth",
      profileRegistryAddress: getAddress(addr),
      votingSchemeAddress: getAddress(addr),
      takeoverGovernorAddress: getAddress(addr),
      curatorRegistryAddress: getAddress(addr),
      zamaRelayerUrl: "https://relayer.example",
    });
  });

  it("reads the curator registry from the build environment", () => {
    vi.stubEnv("NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS", addr.toLowerCase());
    try {
      expect(envDefaults().curatorRegistryAddress).toBe(getAddress(addr));
      vi.stubEnv("NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS", "0x1");
      expect(envDefaults().curatorRegistryAddress).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects invalid values and never lets config.json enable plaintext ballots", () => {
    const d = envDefaults();
    expect(mergeRuntimeConfig(d, { ensParentName: "no_dots" })).toBe(d);
    expect(mergeRuntimeConfig(d, { publisherUrl: "javascript:alert(1)" })).toBe(d);
    expect(mergeRuntimeConfig(d, { votingSchemeAddress: "0x1" })).toBe(d);
    expect(mergeRuntimeConfig(d, { curatorRegistryAddress: "not-an-address" })).toBe(d);
    expect(mergeRuntimeConfig(d, { devPlainBallots: true }).devPlainBallots).toBe(false);
  });
});
