import { getAddress } from "viem";
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
      CORS_ALLOWED_ORIGINS: "https://varada.eth.limo, https://*.eth.limo",
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
    expect(c.corsOrigins).toEqual(["https://varada.eth.limo", "https://*.eth.limo"]);
  });

  it("reads the keeper settings with defaults", () => {
    expect(readConfig({}).keeper).toMatchObject({ enabled: false, dryRun: false, rpcUrls: [], maxTxPerRun: 10, lookbackEpochs: 4, intervalMs: 300_000 });
    const k = readConfig({
      KEEPER_ENABLED: "true",
      KEEPER_DRY_RUN: "1",
      KEEPER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
      ETH_RPC_URL: "https://a.example/key, https://b.example",
      EPOCH_GOVERNOR_ADDRESS: "0x00000000000000000000000000000000000000e1",
      VOTING_SCHEME_ADDRESS: "0x00000000000000000000000000000000000000A1",
      TAKEOVER_GOVERNOR_ADDRESS: "0x00000000000000000000000000000000000000e2",
      FACTORY_ADDRESS: "0x00000000000000000000000000000000000000f1",
      FACTORY_DEPLOY_BLOCK: "21000000",
      KEEPER_MAX_TX_PER_RUN: "3",
      KEEPER_LOOKBACK_EPOCHS: "2",
      ZAMA_RELAYER_URL: "https://relayer.example/",
      ZAMA_RELAYER_API_KEY: "zk",
    }).keeper;
    expect(k).toMatchObject({
      enabled: true,
      dryRun: true,
      rpcUrls: ["https://a.example/key", "https://b.example"],
      votingScheme: getAddress("0x00000000000000000000000000000000000000a1"),
      factoryDeployBlock: 21_000_000n,
      maxTxPerRun: 3,
      lookbackEpochs: 2,
      zamaRelayerUrl: "https://relayer.example",
      zamaRelayerApiKey: "zk",
    });
  });

  it("rejects malformed keeper variables by name", () => {
    expect(() => readConfig({ KEEPER_PRIVATE_KEY: "0xsecret" })).toThrow(/^Invalid publisher environment: KEEPER_PRIVATE_KEY$/);
    expect(() => readConfig({ ETH_RPC_URL: "wss://x" })).toThrow(/ETH_RPC_URL/);
    expect(() => readConfig({ EPOCH_GOVERNOR_ADDRESS: "0x1234" })).toThrow(/EPOCH_GOVERNOR_ADDRESS/);
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
