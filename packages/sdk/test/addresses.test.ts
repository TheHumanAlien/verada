import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_KEYS,
  EXTERNAL_ADDRESSES,
  PLACEHOLDER_DEPLOYMENT,
  isDeployed,
  loadDeployment,
} from "../src/addresses.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("addresses", () => {
  it("ships zero-address placeholders", () => {
    expect(isDeployed(PLACEHOLDER_DEPLOYMENT)).toBe(false);
    for (const k of DEPLOYMENT_KEYS) expect(PLACEHOLDER_DEPLOYMENT[k]).toBe(zeroAddress);
  });

  it("exposes checksummed external addresses", () => {
    expect(EXTERNAL_ADDRESSES.weth).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(EXTERNAL_ADDRESSES.poolManager).toBe("0x000000000004444c5dc75cB358380D2e3dE08A90");
  });

  it("loads and normalizes a deployment", () => {
    const input: Record<string, unknown> = { chainId: 1, deployBlock: "123" };
    DEPLOYMENT_KEYS.forEach((k, i) => (input[k] = addr(i + 1)));
    const d = loadDeployment(input);
    expect(d.deployBlock).toBe(123n);
    expect(isDeployed(d)).toBe(true);
  });

  it("rejects wrong chain, missing and malformed fields", () => {
    const base: Record<string, unknown> = { chainId: 1 };
    DEPLOYMENT_KEYS.forEach((k, i) => (base[k] = addr(i + 1)));
    expect(() => loadDeployment({ ...base, chainId: 5 })).toThrow();
    expect(() => loadDeployment({ ...base, factory: "0x123" })).toThrow();
    const { feeVault: _omit, ...rest } = base;
    expect(() => loadDeployment(rest)).toThrow();
    expect(() => loadDeployment(null)).toThrow();
  });
});
