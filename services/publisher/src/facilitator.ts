import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { encodeFunctionData, isAddressEqual, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";

/**
 * Self-hosted x402 facilitator for Ethereum mainnet, which Coinbase CDP does not settle. Only the
 * indexer calls it (bearer token), and it only settles `exact` EIP-3009 USDC payments to the
 * platform's own mainnet treasury: it pays the gas, so it must not settle anyone else's payments.
 *
 * The settlement key is a 1Claw agent key whose 1Claw policy allows only the USDC contract; the
 * signer below refuses anything other than `transferWithAuthorization` on USDC as well, so a
 * compromised facilitator process still cannot spend the key's ETH on arbitrary calls.
 */

export const MAINNET_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Both EIP-3009 overloads (v,r,s and the bytes-signature form used for smart wallets). */
export const TRANSFER_WITH_AUTHORIZATION_SELECTORS = [
  toFunctionSelector("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"),
  toFunctionSelector("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"),
] as const;

/** Sends a transaction (no value) from the settlement key; 1Claw in production. */
export interface TxSender {
  address: Address;
  send(to: Address, data: Hex): Promise<Hex>;
}

export class ForbiddenSettlementCall extends Error {
  constructor(what: string) {
    super(`facilitator signer refused ${what}`);
    this.name = "ForbiddenSettlementCall";
  }
}

/** A facilitator signer that reads through `client` and can only call USDC `transferWithAuthorization`. */
export function guardedFacilitatorSigner(client: Pick<PublicClient, "readContract" | "verifyTypedData" | "waitForTransactionReceipt" | "getCode">, sender: TxSender, usdc: Address): FacilitatorEvmSigner {
  const allowed = (to: Address, data: Hex) =>
    isAddressEqual(to, usdc) && (TRANSFER_WITH_AUTHORIZATION_SELECTORS as readonly string[]).includes(data.slice(0, 10).toLowerCase());
  return toFacilitatorEvmSigner({
    address: sender.address,
    readContract: (args) => client.readContract(args as never),
    verifyTypedData: (args) => client.verifyTypedData(args as never),
    getCode: (args) => client.getCode(args),
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
    async writeContract(args) {
      const encode = encodeFunctionData as (a: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex;
      const data = (encode({ abi: args.abi, functionName: args.functionName, args: args.args }) +
        (args.dataSuffix ? args.dataSuffix.slice(2) : "")) as Hex;
      if (!allowed(args.address, data)) throw new ForbiddenSettlementCall(`${args.functionName} on ${args.address}`);
      return sender.send(args.address, data);
    },
    async sendTransaction(args) {
      if (!allowed(args.to, args.data)) throw new ForbiddenSettlementCall(`a call to ${args.to}`);
      return sender.send(args.to, args.data);
    },
  });
}

export interface FacilitatorDeps {
  facilitator: Pick<x402Facilitator, "verify" | "settle" | "getSupported">;
  /** Bearer token the indexer sends. */
  token: string;
  network: string;
  /** The only payee this facilitator settles for. */
  payTo: Address;
  log: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export function createMainnetFacilitator(signer: FacilitatorEvmSigner, network: string) {
  // Smart-wallet deployment (ERC-6492 factories) stays disabled: no factory allowlist.
  return new x402Facilitator().register(network as `${string}:${string}`, new ExactEvmScheme(signer, { simulateInSettle: true }));
}

const Body = z.object({
  x402Version: z.number().int(),
  paymentPayload: z.record(z.unknown()),
  paymentRequirements: z.record(z.unknown()),
});

/** Mounts `GET /x402/supported`, `POST /x402/verify` and `POST /x402/settle`. */
export function mountFacilitator(app: Hono, deps: FacilitatorDeps): void {
  const noStore = (c: Context) => c.header("Cache-Control", "no-store");
  const authorized = (c: Context) => {
    const h = c.req.header("authorization") ?? "";
    const want = `Bearer ${deps.token}`;
    if (h.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
  };
  const parse = async (c: Context) => {
    const r = Body.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return null;
    const req = r.data.paymentRequirements as unknown as PaymentRequirements;
    return { payload: r.data.paymentPayload as unknown as PaymentPayload, req };
  };
  /** Refuses requirements this facilitator does not exist to settle. */
  const outOfScope = (req: PaymentRequirements) => {
    if (req.network !== deps.network) return "unsupported_network";
    if (req.scheme !== "exact") return "unsupported_scheme";
    if (typeof req.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.payTo) || !isAddressEqual(req.payTo as Address, deps.payTo)) {
      return "payee_not_allowed";
    }
    return null;
  };

  app.use("/x402/*", async (c, next) => {
    noStore(c);
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/x402/supported", (c) => c.json(deps.facilitator.getSupported()));

  app.post("/x402/verify", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const p = await parse(c);
    if (!p) return c.json({ error: "invalid_request" }, 400);
    const scope = outOfScope(p.req);
    if (scope) return c.json({ isValid: false, invalidReason: scope }, 200);
    return c.json(await deps.facilitator.verify(p.payload, p.req));
  });

  app.post("/x402/settle", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const p = await parse(c);
    if (!p) return c.json({ error: "invalid_request" }, 400);
    const scope = outOfScope(p.req);
    if (scope) return c.json({ success: false, errorReason: scope, transaction: "", network: p.req.network }, 200);
    const r = await deps.facilitator.settle(p.payload, p.req);
    deps.log(r.success ? "info" : "warn", "x402 settlement", { success: r.success, transaction: r.transaction || undefined, errorReason: r.errorReason });
    return c.json(r);
  });
}
