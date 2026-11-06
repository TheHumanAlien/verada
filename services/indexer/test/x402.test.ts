import { buildCatalog, type HarvestedOrg } from "@verada/cause-catalog";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import { catalogStoreOf } from "../src/api/catalog";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { mainnetPrice } from "../src/api/x402";
import { fixtureRepo } from "./api.fixtures";
import { REF, a, h, repo, stored } from "./agents.fixtures";

const BASE_TREASURY = a(0xba5e);
const MAINNET_TREASURY = a(0x0e7);
const ENV = {
  X402_ENABLED: "true",
  X402_BASE_PAY_TO: BASE_TREASURY,
  X402_MAINNET_PAY_TO: MAINNET_TREASURY,
  X402_BASE_FACILITATOR_URL: "https://facilitator.example",
  X402_MAINNET_FACILITATOR_URL: "https://publisher.example/x402",
};
const buyer = privateKeyToAccount(`0x${"42".repeat(32)}`);

function fakeFacilitator(networks: string[]) {
  const calls = { verify: [] as PaymentRequirements[], settle: [] as PaymentRequirements[], payloads: [] as PaymentPayload[] };
  const client: FacilitatorClient = {
    getSupported: async () => ({
      kinds: networks.map((network) => ({ x402Version: 2, scheme: "exact", network: network as `${string}:${string}` })),
      extensions: [],
      signers: {},
    }),
    verify: async (payload, req) => {
      calls.verify.push(req);
      calls.payloads.push(payload);
      return { isValid: true, payer: buyer.address };
    },
    settle: async (_payload, req) => {
      calls.settle.push(req);
      return { success: true, transaction: h(0x77), network: req.network, payer: buyer.address };
    },
  };
  return { client, calls };
}

const org = (i: number, over: Partial<HarvestedOrg>): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(400000000 + i),
  name: `Org ${i}`,
  description: null,
  nteeCode: "K31",
  country: "USA",
  state: "NY",
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});
const { catalog } = buildCatalog([
  org(1, { name: "City Food Bank" }),
  org(2, { name: "Rhino Rescue", nteeCode: "D31", country: "ZAF" }),
  org(3, { name: "Shelter House", nteeCode: "L41" }),
]);

function mk(env: Record<string, string> = ENV, withCatalog = false) {
  const config = readApiConfig(env);
  const r = fixtureRepo();
  const base = fakeFacilitator(["eip155:8453"]);
  const mainnet = fakeFacilitator(["eip155:1"]);
  const app = createApi({
    repo: r,
    search: { search: async () => [] },
    config,
    bus: new ActivityBus(() => r.listActivity({ limit: 100 }), 10_000),
    agents: repo(),
    reports: { get: async (ref) => (ref === REF ? stored : null) },
    catalog: catalogStoreOf(withCatalog ? catalog : null),
    x402Facilitators: [base.client, mainnet.client],
  });
  return { app, base: base.calls, mainnet: mainnet.calls };
}

/** Requests `path`, pays the challenge on `network` with a real EIP-3009 signature, retries. */
async function pay(app: ReturnType<typeof mk>["app"], path: string, network: string) {
  const first = await app.request(path);
  expect(first.status).toBe(402);
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const client = registerExactEvmScheme(
    new x402Client((_v, accepts) => accepts.find((x) => x.network === network)!),
    { signer: buyer },
  );
  const payload = await client.createPaymentPayload(required);
  return app.request(path, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
}

describe("x402 paid routes", () => {
  it("challenges with both networks, platform treasuries and a mainnet price floor", async () => {
    const { app } = mk();
    const res = await app.request("/x402/v1/rankings/hunger/africa");
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(required.x402Version).toBe(2);
    const [base, main] = required.accepts;
    expect(base).toMatchObject({ scheme: "exact", network: "eip155:8453", payTo: BASE_TREASURY, amount: "10000" });
    expect(base!.asset.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(main).toMatchObject({ scheme: "exact", network: "eip155:1", payTo: MAINNET_TREASURY, amount: "500000" });
    expect(main!.asset.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  it("serves the ranking after a Base payment and settles through the Base facilitator only", async () => {
    const { app, base, mainnet } = mk();
    const res = await pay(app, "/x402/v1/rankings/hunger/africa", "eip155:8453");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ region: "africa", verified: true, epoch: "12", agent: { ensName: "hunger.agent.varada.eth" } });
    expect(body.picks.map((p: { rank: number; name: string }) => [p.rank, p.name])).toEqual([[0, "Org A4"], [1, "Org A7"]]);
    expect(body.events[0].url).toBe("https://news.example/a");
    const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settled).toMatchObject({ success: true, transaction: h(0x77), network: "eip155:8453" });
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(base.settle).toHaveLength(1);
    expect(mainnet.verify).toHaveLength(0);
    // The signed authorization pays the platform treasury the quoted amount.
    const auth = (base.payloads[0]!.payload as { authorization: { to: string; value: string; from: string } }).authorization;
    expect(auth.to.toLowerCase()).toBe(BASE_TREASURY.toLowerCase());
    expect(auth.value).toBe("10000");
    expect(auth.from).toBe(buyer.address);
  });

  it("routes a mainnet payment to the publisher's facilitator", async () => {
    const { app, base, mainnet } = mk();
    const res = await pay(app, "/x402/v1/history/hunger", "eip155:1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epochs[0]).toMatchObject({ epoch: "12", reportRef: REF });
    expect(body.epochs[0].regions[0].picks[0]).toMatchObject({ rank: 0, score: 90 });
    expect(mainnet.settle).toHaveLength(1);
    expect(mainnet.settle[0]!.amount).toBe("500000");
    expect(base.verify).toHaveLength(0);
  });

  it("does not charge for a miss: a 4xx after verification cancels settlement", async () => {
    const { app, base } = mk();
    const res = await pay(app, "/x402/v1/rankings/hunger/oceania", "eip155:8453");
    expect(res.status).toBe(404);
    expect(base.verify).toHaveLength(1);
    expect(base.settle).toHaveLength(0);
    const unknown = await pay(app, "/x402/v1/newsletters/nope", "eip155:8453");
    expect(unknown.status).toBe(400);
    expect(base.settle).toHaveLength(0);
  });

  it("serves the newsletter archive", async () => {
    const { app } = mk();
    const res = await pay(app, "/x402/v1/newsletters/hunger", "eip155:8453");
    const body = await res.json();
    expect(body.issues[0]).toMatchObject({ title: "Hunger: week 12", regions: [{ region: "africa", newsletter: "Africa section" }] });
  });

  it("lists prices for free and answers 503 for the export without a catalogue", async () => {
    const { app, base } = mk();
    const list = await app.request("/x402/v1");
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.routes.map((r: { route: string }) => r.route)).toContain("GET /x402/v1/catalog/export");
    expect(body.routes[0].accepts).toHaveLength(2);
    const exp = await pay(app, "/x402/v1/catalog/export", "eip155:8453");
    expect(exp.status).toBe(503);
    expect(base.settle).toHaveLength(0);
  });

  it("exports the classified catalogue with filters and paging", async () => {
    const { app } = mk(ENV, true);
    const all = await (await pay(app, "/x402/v1/catalog/export?limit=2", "eip155:8453")).json();
    expect(all).toMatchObject({ total: 3, offset: 0, limit: 2, root: catalog.meta.root });
    expect(all.items).toHaveLength(2);
    const wild = await (await pay(app, "/x402/v1/catalog/export?category=endangered-species&region=africa", "eip155:8453")).json();
    expect(wild.items.map((o: { name: string }) => o.name)).toEqual(["Rhino Rescue"]);
    expect((await pay(app, "/x402/v1/catalog/export?category=nope", "eip155:8453")).status).toBe(400);
  });

  it("exposes the payment headers to browsers and allows the signature header", async () => {
    const { app } = mk();
    const pre = await app.request("/x402/v1/rankings/hunger/africa", {
      method: "OPTIONS",
      headers: { Origin: "https://varada.com", "Access-Control-Request-Headers": "PAYMENT-SIGNATURE" },
    });
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("PAYMENT-SIGNATURE");
    const res = await app.request("/x402/v1/rankings/hunger/africa", { headers: { Origin: "https://varada.com" } });
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
  });

  it("is absent when disabled, and only Base is offered without a mainnet treasury", async () => {
    const off = mk({});
    expect((await off.app.request("/x402/v1/rankings/hunger/africa")).status).toBe(404);
    expect((await off.app.request("/x402/v1")).status).toBe(404);
    const { X402_MAINNET_PAY_TO: _m, X402_MAINNET_FACILITATOR_URL: _u, ...baseOnly } = ENV;
    const res = await mk(baseOnly).app.request("/x402/v1/history/hunger");
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).accepts.map((x) => x.network)).toEqual(["eip155:8453"]);
  });

  it("validates the configuration", () => {
    expect(() => readApiConfig({ X402_ENABLED: "true" })).toThrow(/X402_BASE_PAY_TO/);
    expect(() => readApiConfig({ X402_MAINNET_PAY_TO: MAINNET_TREASURY })).toThrow(/FACILITATOR_URL/);
    expect(() => readApiConfig({ ...ENV, X402_PRICE_RANKINGS: "1e3" })).toThrow();
    expect(mainnetPrice("0.01", "0.50")).toBe("0.50");
    expect(mainnetPrice("2.5", "0.50")).toBe("2.5");
  });
});
