import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { EndaomentClient, buildSearchQuery, toCauseId, toOrgId, einToOrgId, uuidToOrgId, getMainnetDeployment, summarizeOrg, verifyOrgAddress, MemoryCache, DEV_BASE_URL, ORG_FUND_FACTORY } from "../src/index.js";
import search from "./fixtures/search.json";
import org from "./fixtures/org.json";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => {};

describe("buildSearchQuery", () => {
  it("joins list filters and pagination", () => {
    const q = buildSearchQuery({ searchTerm: "red cross", nteeMajorCodes: ["P", "B"], countries: ["USA"], subdivisions: ["NY", "CA"], count: 5, offset: 10 });
    const p = new URLSearchParams(q);
    expect(p.get("nteeMajorCodes")).toBe("P,B");
    expect(p.get("subdivisions")).toBe("NY,CA");
    expect(p.get("count")).toBe("5");
    expect(p.get("offset")).toBe("10");
  });
  it("rejects out-of-range count", () => {
    expect(() => buildSearchQuery({ count: 26 })).toThrow();
    expect(() => buildSearchQuery({ count: 0 })).toThrow();
  });
});

describe("searchOrganizations", () => {
  it("validates and strips logo fields", async () => {
    const withImages = search.map((o) => ({ ...o, logo: "https://x.invalid/a.png", logoUrl: "https://x.invalid/b.png", image: "https://x.invalid/c.png" }));
    const f = vi.fn(async (_u?: string) => json(withImages));
    const c = new EndaomentClient({ fetch: f as any });
    const res = await c.searchOrganizations({ searchTerm: "relief" });
    expect(res).toHaveLength(2);
    expect(JSON.stringify(res)).not.toMatch(/logo|image|x\.invalid/);
    expect(String(f.mock.calls[0]![0])).toContain("/v2/orgs/search?searchTerm=relief");
  });
  it("rejects malformed responses", async () => {
    const c = new EndaomentClient({ fetch: (async () => json([{ id: 1 }])) as any });
    await expect(c.searchOrganizations()).rejects.toThrow();
  });
  it("caches identical requests", async () => {
    const f = vi.fn(async (_u?: string) => json(search));
    const c = new EndaomentClient({ fetch: f as any, cache: new MemoryCache() });
    await c.searchOrganizations();
    await c.searchOrganizations();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("paginates with searchAll", async () => {
    const f = vi.fn(async (u: string) => json(new URL(u).searchParams.get("offset") === "0" ? search : []));
    const c = new EndaomentClient({ fetch: f as any, cache: null });
    const out = [];
    for await (const o of c.searchAll({ count: 2 })) out.push(o);
    expect(out).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("retries", () => {
  it("retries 503 then succeeds with backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}, 429, { "retry-after": "2" })).mockResolvedValueOnce(json(search));
    const c = new EndaomentClient({ fetch: f as any, sleep, retryBaseDelayMs: 100, cache: null });
    await c.searchOrganizations();
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((x) => x[0])).toEqual([100, 2000]);
  });
  it("does not retry 400 and gives up after maxRetries", async () => {
    const f400 = vi.fn(async () => json({}, 400));
    await expect(new EndaomentClient({ fetch: f400 as any, sleep: noSleep, cache: null }).searchOrganizations()).rejects.toMatchObject({ status: 400 });
    expect(f400).toHaveBeenCalledTimes(1);
    const f500 = vi.fn(async () => json({}, 500));
    await expect(new EndaomentClient({ fetch: f500 as any, sleep: noSleep, maxRetries: 2, cache: null }).searchOrganizations()).rejects.toMatchObject({ status: 500 });
    expect(f500).toHaveBeenCalledTimes(3);
  });
  it("retries network errors", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValueOnce(json(search));
    await new EndaomentClient({ fetch: f as any, sleep: noSleep, cache: null }).searchOrganizations();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("getCounts", () => {
  it("queries major codes and validates the response", async () => {
    const body = { counts: [{ nteeCode: "A", orgCount: 3 }, { nteeCode: "Z", orgCount: 9 }], asOf: "2026-11-05T00:00:00.000Z" };
    const f = vi.fn(async (_u?: string) => json(body));
    const c = new EndaomentClient({ fetch: f as any });
    const res = await c.getCounts(["A", "Z"]);
    expect(res.counts).toHaveLength(2);
    expect(String(f.mock.calls[0]![0])).toContain("/v1/orgs/counts?nteeMajorCodes=A,Z");
  });
  it("rejects invalid codes", async () => {
    const c = new EndaomentClient({ fetch: (async () => json({})) as any });
    await expect(c.getCounts(["AB"])).rejects.toThrow();
    await expect(c.getCounts([])).rejects.toThrow();
  });
});

describe("getOrganization", () => {
  it("parses details without logo", async () => {
    const f = vi.fn(async (_u?: string) => json(org));
    const c = new EndaomentClient({ fetch: f as any });
    const o = await c.getOrganization("20-0049703");
    expect(getMainnetDeployment(o!)).toEqual({ address: "0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1", isDeployed: true });
    expect(o?.isCompliant).toBe(true);
    expect(o?.claimed).toBe(false);
    expect(JSON.stringify(o)).not.toContain("logo");
    expect(String(f.mock.calls[0]![0])).toContain("/v1/orgs/20-0049703");
  });
  it("returns null on 404", async () => {
    const c = new EndaomentClient({ fetch: (async () => json({}, 404)) as any });
    expect(await c.getOrganization("000000000")).toBeNull();
  });
});

const REAL_ORGS = [
  { ein: "200049703", id: "10b6c970-dcf3-4527-95f4-dbe25aae1a43", orgId: "0x3230303034393730330000000000000000000000000000000000000000000000", addr: "0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1" },
  { ein: "873024488", id: "04efc623-f3e8-496f-89ef-c677bb5d6245", orgId: "0x3837333032343438380000000000000000000000000000000000000000000000", addr: "0x2EDFF2D6AE1c9E5345F1D4A4437bB8fB1BCf9560" },
];

describe("orgId derivation", () => {
  it("encodes EIN digits left-aligned without the hyphen", () => {
    for (const o of REAL_ORGS) expect(einToOrgId(o.ein)).toBe(o.orgId);
    expect(einToOrgId("87-3024488")).toBe(REAL_ORGS[1]!.orgId);
    expect(toOrgId({ ein: "87-3024488", id: "ignored" })).toBe(REAL_ORGS[1]!.orgId);
  });
  it("rejects malformed EINs", () => {
    expect(() => einToOrgId("12345")).toThrow();
    expect(() => einToOrgId("abcdefghi")).toThrow();
  });
  it("uses the UUID rule when there is no EIN", () => {
    expect(toOrgId({ ein: null, id: "6ed70542-47a1-bcf4-f1fe-7be4607ff13e" })).toBe(
      "0x6ed7054247a1bcf4f1fe7be4607ff13e00000000000000000000000000000000",
    );
    expect(uuidToOrgId("6ED70542-47A1-BCF4-F1FE-7BE4607FF13E")).toBe(uuidToOrgId("6ed70542-47a1-bcf4-f1fe-7be4607ff13e"));
    expect(() => uuidToOrgId("nope")).toThrow();
  });
  it("throws with no identifier", () => {
    expect(() => toOrgId({})).toThrow();
    expect(() => toCauseId({})).toThrow();
  });
});

describe("toCauseId", () => {
  it("is keccak256 of the orgId and independent of EIN formatting", () => {
    expect(toCauseId({ ein: "87-3024488" })).toBe(keccak256(REAL_ORGS[1]!.orgId as `0x${string}`));
    expect(toCauseId({ ein: "873024488" })).toBe(toCauseId({ ein: "87-3024488", id: "x" }));
  });
});

describe("mainnet deployment and address verification", () => {
  it("picks the chain 1 entry regardless of array order", () => {
    const o = search[0]!;
    expect(o.deployments[0]!.chainId).toBe(8453);
    expect(getMainnetDeployment(o)).toEqual({ address: "0x2EDFF2D6AE1c9E5345F1D4A4437bB8fB1BCf9560", isDeployed: false });
    expect(getMainnetDeployment({ deployments: [] })).toBeNull();
  });
  it("summarizes compliance, claim and orgId", () => {
    expect(summarizeOrg(search[0]!)).toEqual({ orgId: REAL_ORGS[1]!.orgId, address: REAL_ORGS[1]!.addr, isDeployed: false, isCompliant: true, claimed: false });
    expect(summarizeOrg(search[1]!).isCompliant).toBe(true);
  });
  it("verifies against computeOrgAddress", async () => {
    const calls: unknown[] = [];
    const mk = (addr: string) => ({ readContract: async (a: unknown) => (calls.push(a), addr) }) as any;
    const ok = await verifyOrgAddress(mk(REAL_ORGS[1]!.addr), search[0]!);
    expect(ok.ok).toBe(true);
    expect(calls[0]).toMatchObject({ address: ORG_FUND_FACTORY, functionName: "computeOrgAddress", args: [REAL_ORGS[1]!.orgId] });
    const bad = await verifyOrgAddress(mk("0x0000000000000000000000000000000000000001"), search[0]!);
    expect(bad.ok).toBe(false);
    const none = await verifyOrgAddress(mk(REAL_ORGS[1]!.addr), { ...search[0]!, deployments: [] });
    expect(none.ok).toBe(false);
  });
  const rpc = process.env.ETH_RPC_URL;
  it.skipIf(!rpc)("matches the real factory for EIN and international orgs (fork)", async () => {
    const { createPublicClient, http } = await import("viem");
    const { mainnet } = await import("viem/chains");
    const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
    for (const o of search) expect((await verifyOrgAddress(client, o)).ok).toBe(true);
  });
});

describe("base url", () => {
  it("defaults to the production server", async () => {
    const f = vi.fn(async (_u?: string) => json(search));
    await new EndaomentClient({ fetch: f as any, cache: null }).searchOrganizations();
    expect(f.mock.calls[0]![0]!.startsWith("https://api.endaoment.org/")).toBe(true);
  });
  it("honours an explicit dev baseUrl", async () => {
    const f = vi.fn(async (_u?: string) => json(search));
    await new EndaomentClient({ fetch: f as any, cache: null, baseUrl: DEV_BASE_URL }).searchOrganizations();
    expect(f.mock.calls[0]![0]!.startsWith("https://api.dev.endaoment.org/")).toBe(true);
  });
});
