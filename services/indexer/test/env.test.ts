import { describe, expect, it } from "vitest";
import { readEnv } from "../src/env";

const base = {
  PONDER_RPC_URL_1: "http://localhost:8545",
  START_BLOCK: "100",
  FACTORY_ADDRESS: "0x0000000000000000000000000000000000000001",
  FEE_VAULT_ADDRESS: "0x0000000000000000000000000000000000000002",
  FEE_CONSOLIDATOR_ADDRESS: "0x0000000000000000000000000000000000000006",
  QUOTE_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000007",
  CAUSE_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000003",
  EPOCH_GOVERNOR_ADDRESS: "0x0000000000000000000000000000000000000004",
  DONATION_DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000005",
  TOKEN_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000008",
  CAUSE_CATALOG_ADDRESS: "0x000000000000000000000000000000000000000c",
  CURATOR_REGISTRY_ADDRESS: "0x000000000000000000000000000000000000000d",
  VOTING_SCHEME_ADDRESS: "0x0000000000000000000000000000000000000009",
  TAKEOVER_GOVERNOR_ADDRESS: "0x000000000000000000000000000000000000000a",
};

describe("readEnv", () => {
  it("parses a complete environment", () => {
    expect(readEnv(base).startBlock).toBe(100);
  });
  it("rejects a missing rpc url", () => {
    expect(() => readEnv({ ...base, PONDER_RPC_URL_1: undefined })).toThrow(/PONDER_RPC_URL_1/);
  });
  it("splits a comma-separated rpc list", () => {
    const urls = readEnv({ ...base, PONDER_RPC_URL_1: " https://a.example/rpc , https://b.example/eth/public,," }).rpcUrls;
    expect(urls).toEqual(["https://a.example/rpc", "https://b.example/eth/public"]);
  });
  it("rejects a non-url rpc entry", () => {
    expect(() => readEnv({ ...base, PONDER_RPC_URL_1: "https://a.example,not-a-url" })).toThrow(/not-a-url/);
  });
  it("requires the consolidator and quote registry addresses", () => {
    expect(() => readEnv({ ...base, FEE_CONSOLIDATOR_ADDRESS: undefined })).toThrow(/FEE_CONSOLIDATOR_ADDRESS/);
    expect(() => readEnv({ ...base, QUOTE_REGISTRY_ADDRESS: undefined })).toThrow(/QUOTE_REGISTRY_ADDRESS/);
  });
  it("requires the profile registry, voting scheme and takeover governor addresses", () => {
    for (const k of ["TOKEN_REGISTRY_ADDRESS", "VOTING_SCHEME_ADDRESS", "TAKEOVER_GOVERNOR_ADDRESS", "CAUSE_CATALOG_ADDRESS"]) {
      expect(() => readEnv({ ...base, [k]: undefined })).toThrow(new RegExp(k));
    }
    expect(readEnv(base).takeoverGovernor).toBe(base.TAKEOVER_GOVERNOR_ADDRESS);
  });
  it("rejects a zero start block", () => {
    expect(() => readEnv({ ...base, START_BLOCK: "0" })).toThrow(/START_BLOCK/);
  });
  it("rejects a malformed address", () => {
    expect(() => readEnv({ ...base, FACTORY_ADDRESS: "0x12" })).toThrow(/FACTORY_ADDRESS/);
  });
});
