import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, type Address, type ContractFunctionParameters } from "viem";
import { agentVaultAbi } from "@verada/sdk/abis";
import { allowanceRequest, approveRequest, donateRequest, needsApproval, parseUsdcInput, usdcAddress } from "@/lib/vault";

const VAULT = "0x00000000000000000000000000000000000000b1" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

describe("parseUsdcInput", () => {
  it.each([
    ["25", 25_000_000n],
    [" 12.5 ", 12_500_000n],
    [".5", 500_000n],
    ["3.", 3_000_000n],
    ["0.000001", 1n],
    ["1.123456", 1_123_456n],
    ["007", 7_000_000n],
  ])("%j -> %s", (input, amount) => {
    expect(parseUsdcInput(input)).toEqual({ ok: true, amount });
  });

  it.each(["", " ", ".", "0", "0.0", "0.0000001", "1.1234567", "-1", "+1", "1e6", "1,000", "abc", "1.2.3", "0x10", "1 000", "9999999999999999"])("%j is rejected", (input) => {
    const r = parseUsdcInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });
});

describe("vault requests", () => {
  it("knows USDC on mainnet only", () => {
    expect(usdcAddress(1)).toBe(USDC);
    expect(usdcAddress(31337)).toBe(USDC);
    expect(usdcAddress(8453)).toBeNull();
  });

  it("builds approve and donate calls that encode", () => {
    const approve = approveRequest({ usdc: USDC, vault: VAULT, amount: 5n, chainId: 1 });
    const donate = donateRequest({ vault: VAULT, amount: 5n, credit: true, chainId: 1 });
    // Type-level: the shapes fit viem/wagmi contract call parameters.
    const a: ContractFunctionParameters<typeof erc20Abi, "nonpayable", "approve"> = approve;
    const d: ContractFunctionParameters<typeof agentVaultAbi, "nonpayable", "donate"> = donate;
    expect(a.address).toBe(USDC);
    expect(approve.args).toEqual([VAULT, 5n]);
    expect(d.address).toBe(VAULT);
    expect(donate.args).toEqual([5n, true]);
    expect(donate.chainId).toBe(1);
    expect(encodeFunctionData(approve)).toMatch(/^0x095ea7b3/);
    expect(encodeFunctionData({ abi: donate.abi, functionName: donate.functionName, args: donate.args })).toMatch(/^0x[0-9a-f]{8}/);
    expect(donateRequest({ vault: VAULT, amount: 1n, credit: false, chainId: 1 }).args[1]).toBe(false);
  });

  it("reads the allowance and decides on approval", () => {
    const r = allowanceRequest({ usdc: USDC, owner: VAULT, vault: VAULT, chainId: 1 });
    expect(r.functionName).toBe("allowance");
    expect(needsApproval(undefined, 1n)).toBe(true);
    expect(needsApproval(0n, 1n)).toBe(true);
    expect(needsApproval(1n, 1n)).toBe(false);
  });
});
