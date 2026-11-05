import { describe, expect, it } from "vitest";
import { readConfig } from "../src/env.js";

describe("readConfig", () => {
  it("applies defaults", () => {
    const c = readConfig({});
    expect(c).toMatchObject({
      port: 42070,
      chainId: 1,
      maxLogoBytes: 2 * 1024 * 1024,
      maxMetadataBytes: 64 * 1024,
      jobIntervalMs: 60_000,
      corsOrigins: [],
      arkiv: { enabled: false, dryRun: false, chain: "rabdi" },
    });
    expect(c.swarm.gatewayUrl).toBeUndefined();
  });

  it("reads exactly the variables infra sets", () => {
    const c = readConfig({
      PORT: "42070",
      BEE_GATEWAY_URL: "https://swarm.verada.xyz/",
      PUBLIC_GATEWAY_URL: "https://swarm.verada.xyz",
      INDEXER_URL: "https://api.verada.xyz",
      ARKIV_CHAIN: "rabdi",
      ARKIV_ENABLED: "true",
      CORS_ALLOWED_ORIGINS: "https://verada.eth.limo, https://*.eth.limo",
      JOB_INTERVAL_SECONDS: "60",
      BEE_GATEWAY_AUTH_SECRET: "s3cret",
      SWARM_BATCH_ID: `0x${"AB".repeat(32)}`,
      ARKIV_ACCESS_KEY: "key",
      ARKIV_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      KEEPER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
      ETH_RPC_URL: "https://rpc.example",
      NODE_ENV: "production",
    });
    expect(c.swarm).toEqual({
      gatewayUrl: "https://swarm.verada.xyz",
      authSecret: "s3cret",
      stampsUrl: "https://swarm.verada.xyz",
      batchId: "ab".repeat(32),
      publicGatewayUrl: "https://swarm.verada.xyz",
    });
    expect(c.arkiv.enabled).toBe(true);
    expect(c.corsOrigins).toEqual(["https://verada.eth.limo", "https://*.eth.limo"]);
  });

  it("names invalid variables without echoing their values", () => {
    expect(() => readConfig({ ARKIV_PRIVATE_KEY: "not-a-key-but-secret", PORT: "0" })).toThrow(/ARKIV_PRIVATE_KEY, PORT|PORT, ARKIV_PRIVATE_KEY/);
    try {
      readConfig({ ARKIV_PRIVATE_KEY: "not-a-key-but-secret" });
    } catch (e) {
      expect((e as Error).message).not.toContain("not-a-key-but-secret");
    }
  });
});
