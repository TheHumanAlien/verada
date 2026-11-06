import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbi, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createMainnetFacilitator,
  ForbiddenSettlementCall,
  guardedFacilitatorSigner,
  MAINNET_USDC,
  type TxSender,
} from "../src/facilitator.js";
import { config } from "./helpers.js";

const TOKEN = "facilitator-secret";
const TREASURY: Address = "0x00000000000000000000000000000000000000e7";
const buyer = privateKeyToAccount(`0x${"42".repeat(32)}`);
const settler = privateKeyToAccount(`0x${"43".repeat(32)}`);

const AUTH_ABI = parseAbi([
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
]);

/** A chain that answers the reads EIP-3009 verification makes, and records sends. */
function fakeChain() {
  const sent: { to: Address; data: Hex }[] = [];
  const client = {
    readContract: async (args: { functionName: string }) => {
      switch (args.functionName) {
        case "balanceOf":
          return 1_000_000_000n;
        case "authorizationState":
          return false;
        case "name":
          return "USD Coin";
        case "version":
          return "2";
        case "transferWithAuthorization":
          // The simulation (eth_call) of the settlement succeeds.
          return undefined;
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    // USDC is a contract; the buyer is an EOA.
    getCode: async ({ address }: { address: Address }) => (address.toLowerCase() === MAINNET_USDC.toLowerCase() ? ("0x6080" as Hex) : undefined),
    // The receipt carries USDC's Transfer event for the last authorization sent.
    waitForTransactionReceipt: async () => {
      const last = sent.at(-1)!;
      const [from, to, value] = decodeFunctionData({ abi: AUTH_ABI, data: last.data }).args;
      return {
        status: "success",
        logs: [
          {
            address: last.to,
            topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
            data: encodeAbiParameters([{ type: "uint256" }], [value]),
          },
        ],
      };
    },
  };
  const sender: TxSender = {
    address: settler.address,
    send: async (to, data) => {
      sent.push({ to, data });
      return `0x${"77".repeat(32)}`;
    },
  };
  return { client, sender, sent };
}

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:1",
  asset: MAINNET_USDC,
  amount: "500000",
  payTo: TREASURY,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

async function signedPayment(req: PaymentRequirements) {
  const required: PaymentRequired = { x402Version: 2, resource: { url: "https://indexer.example/x402/v1/history/hunger", description: "", mimeType: "application/json" }, accepts: [req] };
  const client = registerExactEvmScheme(new x402Client(), { signer: buyer });
  return client.createPaymentPayload(required);
}

function setup() {
  const chain = fakeChain();
  const facilitator = createMainnetFacilitator(guardedFacilitatorSigner(chain.client as never, chain.sender, MAINNET_USDC), "eip155:1");
  const app = createApp({ config: config(), facilitator: { facilitator, token: TOKEN, network: "eip155:1", payTo: TREASURY }, log: () => {} });
  const call = (path: string, body?: unknown, token = TOKEN) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, sent: chain.sent };
}

describe("mainnet x402 facilitator", () => {
  it("lists exact on mainnet and requires the bearer token", async () => {
    const { call } = setup();
    const res = await call("/x402/supported");
    expect(res.status).toBe(200);
    expect((await res.json()).kinds).toContainEqual(expect.objectContaining({ x402Version: 2, scheme: "exact", network: "eip155:1" }));
    expect((await call("/x402/supported", undefined, "wrong")).status).toBe(401);
  });

  it("verifies and settles a USDC authorization to the treasury with transferWithAuthorization", async () => {
    const { call, sent } = setup();
    const req = requirements();
    const paymentPayload = await signedPayment(req);
    const verify = await (await call("/x402/verify", { x402Version: 2, paymentPayload, paymentRequirements: req })).json();
    expect(verify.invalidReason ?? null, verify.invalidMessage).toBeNull();
    expect(verify).toMatchObject({ isValid: true, payer: buyer.address });
    const settle = await (await call("/x402/settle", { x402Version: 2, paymentPayload, paymentRequirements: req })).json();
    expect(settle.errorReason ?? null, settle.errorMessage).toBeNull();
    expect(settle).toMatchObject({ success: true, network: "eip155:1", transaction: `0x${"77".repeat(32)}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(MAINNET_USDC.toLowerCase());
    const call0 = decodeFunctionData({ abi: AUTH_ABI, data: sent[0]!.data });
    expect(call0.args[0]).toBe(buyer.address);
    expect((call0.args[1] as string).toLowerCase()).toBe(TREASURY);
    expect(call0.args[2]).toBe(500000n);
  });

  it("refuses payments to anyone but the treasury, other networks and other schemes", async () => {
    const { call, sent } = setup();
    for (const req of [requirements({ payTo: "0x00000000000000000000000000000000000000aa" }), requirements({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })]) {
      const paymentPayload = await signedPayment(req);
      const v = await (await call("/x402/verify", { x402Version: 2, paymentPayload, paymentRequirements: req })).json();
      expect(v.isValid).toBe(false);
      const s = await (await call("/x402/settle", { x402Version: 2, paymentPayload, paymentRequirements: req })).json();
      expect(s.success).toBe(false);
    }
    expect(sent).toHaveLength(0);
    expect((await call("/x402/verify", { nope: 1 })).status).toBe(400);
  });

  it("the settlement signer can only call USDC transferWithAuthorization", async () => {
    const { client, sender, sent } = fakeChain();
    const signer = guardedFacilitatorSigner(client as never, sender, MAINNET_USDC);
    await expect(
      signer.writeContract({ address: MAINNET_USDC, abi: erc20Abi, functionName: "transfer", args: [TREASURY, 1n] }),
    ).rejects.toBeInstanceOf(ForbiddenSettlementCall);
    await expect(signer.sendTransaction({ to: "0x00000000000000000000000000000000000000f0", data: "0xa9059cbb" })).rejects.toBeInstanceOf(ForbiddenSettlementCall);
    await expect(signer.sendTransaction({ to: MAINNET_USDC, data: "0xe3ee160e" })).resolves.toMatch(/^0x77/);
    expect(sent).toHaveLength(1);
  });

  it("is absent unless configured", async () => {
    const app = createApp({ config: config(), log: () => {} });
    expect((await app.request("/x402/supported")).status).toBe(404);
  });
});
