import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityBus } from "../src/api/bus";
import { readApiConfig } from "../src/api/config";
import { decodeCursor, encodeCursor } from "../src/api/cursor";
import { createApi } from "../src/api/routes";
import { BoundedTtlCache, type CauseSearch, createCauseSearch, toResult } from "../src/api/search";
import { RateLimiter, matchOrigin } from "../src/api/security";
import { type ActivityItem, activityCursor } from "../src/api/types";
import { T1, T2, activity, fixtureRepo } from "./api.fixtures";

declare global {
  interface Response {
    // biome-ignore lint/suspicious/noExplicitAny: test convenience for JSON bodies
    json(): Promise<any>;
  }
}

const baseEnv = {};
const mkApp = (env: Record<string, string> = baseEnv, search: CauseSearch = { search: async () => [] }) => {
  const config = readApiConfig(env);
  const repo = fixtureRepo();
  const bus = new ActivityBus(() => repo.listActivity({ limit: 100 }), 10_000);
  return { app: createApi({ repo, search, config, bus }), bus, config };
};
const get = (app: ReturnType<typeof createApi>, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

describe("tokens", () => {
  it("lists newest first with cursor pagination and fee totals", async () => {
    const { app } = mkApp();
    const r1 = await get(app, "/api/tokens?limit=2");
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.items.map((t: { address: string }) => t.address)).toHaveLength(2);
    expect(b1.items[0].createdAt).toBe("1020");
    expect(b1.items[0].lpTokenId).toBe("3");
    expect(b1.nextCursor).toBeTruthy();
    const r2 = await get(app, `/api/tokens?limit=2&cursor=${b1.nextCursor}`);
    const b2 = await r2.json();
    expect(b2.items).toHaveLength(1);
    expect(b2.items[0].address).toBe(T1);
    expect(b2.items[0].feeTotals.causeAmount).toBe("90000000");
    expect(b2.nextCursor).toBeNull();
  });

  it("returns a token, 404 for unknown, 400 for bad address", async () => {
    const { app } = mkApp();
    expect((await get(app, `/api/tokens/${T1}`)).status).toBe(200);
    expect((await get(app, `/api/tokens/${T1.toUpperCase().replace("0X", "0x")}`)).status).toBe(200);
    expect((await get(app, "/api/tokens/0x00000000000000000000000000000000000000ff")).status).toBe(404);
    const bad = await get(app, "/api/tokens/nope");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_request");
  });

  it("validates limit and cursor", async () => {
    const { app } = mkApp();
    expect((await get(app, "/api/tokens?limit=0")).status).toBe(400);
    expect((await get(app, "/api/tokens?limit=101")).status).toBe(400);
    expect((await get(app, "/api/tokens?cursor=garbage")).status).toBe(400);
    expect((await get(app, "/api/tokens?cursor=&limit=")).status).toBe(200);
  });
});

describe("activity", () => {
  it("pages through the whole feed without gaps or duplicates", async () => {
    const { app } = mkApp();
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const r = await get(app, `/api/activity?limit=3&cursor=${cursor}`);
      const b = await r.json();
      seen.push(...b.items.map((x: { id: string }) => x.id));
      if (!b.nextCursor) break;
      cursor = b.nextCursor;
    }
    expect(seen).toEqual(activity.map((a) => a.id));
    expect(new Set(seen).size).toBe(activity.length);
  });

  it("filters by kind and token and serializes bigints as strings", async () => {
    const { app } = mkApp();
    const b = await (await get(app, "/api/activity?kind=fees,donation")).json();
    expect(b.items.every((i: { kind: string }) => ["fees", "donation"].includes(i.kind))).toBe(true);
    const d = b.items.find((i: { kind: string }) => i.kind === "donation");
    expect(d.timestamp).toBe("2050");
    expect(d.data.amount).toBe("5000000");
    const t2 = await (await get(app, `/api/activity?token=${T2}`)).json();
    expect(t2.items.every((i: { token: string }) => i.token === T2)).toBe(true);
    expect((await get(app, "/api/activity?kind=bogus")).status).toBe(400);
    expect((await get(app, "/api/activity?token=zz")).status).toBe(400);
  });
});

describe("epochs, causes, stats", () => {
  it("lists epochs newest first and fetches one with donations", async () => {
    const { app } = mkApp();
    const l = await (await get(app, `/api/epochs/${T1}?limit=2`)).json();
    expect(l.items.map((e: { epoch: string }) => e.epoch)).toEqual(["2", "1"]);
    const l2 = await (await get(app, `/api/epochs/${T1}?limit=2&cursor=${l.nextCursor}`)).json();
    expect(l2.items.map((e: { epoch: string }) => e.epoch)).toEqual(["0"]);
    const e = await (await get(app, `/api/epochs/${T1}/0`)).json();
    expect(e.donations[0].amount).toBe("5000000");
    expect((await get(app, `/api/epochs/${T1}/99`)).status).toBe(404);
    expect((await get(app, `/api/epochs/${T1}/x`)).status).toBe(400);
  });

  it("serves causes and USDC stats", async () => {
    const { app } = mkApp();
    expect((await (await get(app, "/api/causes")).json()).items).toHaveLength(1);
    const s = await (await get(app, "/api/stats")).json();
    expect(s).toMatchObject({ decimals: 6, currency: "USDC", donatedUsdc: "5000000", tokens: 3 });
  });
});

describe("cause search", () => {
  const upstream = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      ein: "12-3456789",
      name: "Clean Water Fund",
      description: "d",
      logo: "https://img.example/logo.png",
      address: {},
      featuredIndex: 0,
      isCompliant: true,
      lifetimeContributionsUsdc: "0",
      donationsReceived: 0,
      grantsReceived: 0,
      claimed: true,
      deployments: [
        { chainId: 1, contractAddress: "0x00000000000000000000000000000000000000c1", isDeployed: true },
      ],
    },
  ];

  it("proxies with a whitelisted shape, caches, and never leaks image urls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstream), { status: 200 }));
    const search = createCauseSearch({ ttlMs: 60_000, maxEntries: 10, fetch: fetchMock as never });
    const { app } = mkApp({}, search);
    const r = await get(app, "/api/causes/search?q=%20clean%20%20water&limit=1");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toMatch(/logo|img\.example|http/);
    const b = JSON.parse(text);
    expect(Object.keys(b.items[0]).sort()).toEqual(["address", "id", "isDeployed", "name", "orgId"]);
    expect(b.items[0].isDeployed).toBe(true);
    expect(b.items[0].orgId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.nextCursor).toBeTruthy();
    await get(app, "/api/causes/search?q=clean water&limit=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("searchTerm=clean+water");
    expect(calledUrl).toContain("count=1");
  });

  it("validates input and maps upstream failure to 502", async () => {
    const failing = createCauseSearch({
      ttlMs: 1000,
      maxEntries: 10,
      fetch: (async () => new Response("x", { status: 400 })) as never,
    });
    const { app } = mkApp({}, failing);
    expect((await get(app, "/api/causes/search")).status).toBe(400);
    expect((await get(app, "/api/causes/search?q=a")).status).toBe(400);
    expect((await get(app, "/api/causes/search?q=ab&limit=26")).status).toBe(400);
    expect((await get(app, "/api/causes/search?q=ab&cursor=zz")).status).toBe(400);
    const r = await get(app, "/api/causes/search?q=ab");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("toResult tolerates a missing mainnet deployment", () => {
    const r = toResult({ ...upstream[0]!, deployments: [] } as never);
    expect(r.address).toBeNull();
    expect(r.isDeployed).toBe(false);
  });

  it("bounded cache evicts and expires", () => {
    let now = 0;
    const c = new BoundedTtlCache(2, () => now);
    c.set("a", 1, 10);
    c.set("b", 2, 10);
    c.set("c", 3, 10);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe(3);
    now = 11;
    expect(c.get("c")).toBeUndefined();
  });
});

describe("http behaviour", () => {
  it("adds caching headers and answers conditional requests with 304", async () => {
    const { app } = mkApp();
    const r = await get(app, "/api/stats");
    expect(r.headers.get("cache-control")).toMatch(/s-maxage=\d+/);
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const again = await get(app, "/api/stats", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect((await get(app, "/api/health")).headers.get("cache-control")).toBe("no-store");
  });

  it("rejects non-read methods, long urls and bodies", async () => {
    const { app } = mkApp({ MAX_URL_LENGTH: "256" });
    expect((await app.request("/api/tokens", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await get(app, `/api/tokens?cursor=${"a".repeat(300)}`)).status).toBe(414);
    const r = await app.request("/api/tokens", { headers: { "content-length": "10" } });
    expect(r.status).toBe(413);
  });

  it("returns json 404 and hides internals on errors", async () => {
    const { app } = mkApp();
    expect((await get(app, "/api/nope")).status).toBe(404);
    const config = readApiConfig({});
    const broken = createApi({
      repo: {
        ...fixtureRepo(),
        stats: async () => {
          throw new Error("password=hunter2 postgres://u:p@h/db");
        },
      },
      search: { search: async () => [] },
      config,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await get(broken, "/api/stats");
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('{"error":"internal_error"}');
  });

  it("rate limits per IP with Retry-After", async () => {
    const { app } = mkApp({ RATE_LIMIT_BURST: "2", RATE_LIMIT_RPS: "1" });
    const h = { "x-forwarded-for": "1.1.1.1" };
    expect((await get(app, "/api/health", h)).status).toBe(200);
    expect((await get(app, "/api/health", h)).status).toBe(200);
    const r = await get(app, "/api/health", h);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await get(app, "/api/health", { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    // Spoofed leading entries do not help when one proxy hop is trusted.
    expect((await get(app, "/api/health", { "x-forwarded-for": "9.9.9.9, 1.1.1.1" })).status).toBe(429);
  });
});

describe("cors", () => {
  it("defaults to any origin for GET and answers preflight", async () => {
    const { app } = mkApp();
    const r = await get(app, "/api/stats", { origin: "https://anything.example" });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const p = await app.request("/api/stats", {
      method: "OPTIONS",
      headers: { origin: "https://x.example", "access-control-request-method": "GET" },
    });
    expect(p.status).toBe(204);
    expect(p.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(p.headers.get("access-control-allow-headers")).toContain("Last-Event-ID");
  });

  it("enforces an allowlist with wildcard-suffix patterns", async () => {
    const { app } = mkApp({ CORS_ALLOWED_ORIGINS: "https://verada.example, *.bzz.link,*.eth.limo" });
    const ok = await get(app, "/api/stats", { origin: "https://verada.eth.limo" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://verada.eth.limo");
    expect(ok.headers.get("vary")).toContain("Origin");
    const no = await get(app, "/api/stats", { origin: "https://evil.example" });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    const pf = await app.request("/api/stats", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(pf.status).toBe(403);
  });

  it("matches origins strictly", () => {
    const allow = ["*.bzz.link", "https://*.eth.limo", "https://exact.example"];
    expect(matchOrigin(allow, "https://a.b.bzz.link")).toBe("https://a.b.bzz.link");
    expect(matchOrigin(allow, "https://bzz.link")).toBeNull();
    expect(matchOrigin(allow, "https://evilbzz.link")).toBeNull();
    expect(matchOrigin(allow, "https://bzz.link.evil.com")).toBeNull();
    expect(matchOrigin(allow, "http://x.eth.limo")).toBeNull();
    expect(matchOrigin(allow, "https://exact.example")).toBe("https://exact.example");
    expect(matchOrigin(allow, "null")).toBeNull();
    expect(matchOrigin(allow, undefined)).toBeNull();
    expect(matchOrigin([], undefined)).toBe("*");
  });
});

describe("rate limiter", () => {
  it("refills over time and bounds its key set", () => {
    let now = 0;
    const l = new RateLimiter(1, 2, () => now, 3);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(false);
    now = 1000;
    expect(l.take("a").ok).toBe(true);
    for (const k of ["b", "c", "d", "e"]) l.take(k);
    expect(l.take("a").ok).toBeDefined();
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const c = { t: "123", k: "fees:abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("%%%")).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"x","k":"y"}').toString("base64url"))).toBeNull();
  });
});

describe("SSE stream", () => {
  const item = (id: string, ts: number): ActivityItem => ({
    id: `fees:${id}`,
    kind: "fees",
    timestamp: BigInt(ts),
    token: T1,
    txHash: null,
    data: { causeAmount: 1n },
  });

  it("bus announces only unseen items, oldest first, after seeding", async () => {
    let feed = [item("a", 10)];
    const bus = new ActivityBus(async () => feed, 10_000);
    const got: string[] = [];
    const un = bus.subscribe((items) => got.push(...items.map((i) => i.id)));
    await new Promise((r) => setTimeout(r, 5));
    feed = [item("c", 12), item("b", 11), item("a", 10)];
    await bus.tick();
    expect(got).toEqual(["fees:b", "fees:c"]);
    await bus.tick();
    expect(got).toHaveLength(2);
    un();
    expect(bus.size).toBe(0);
  });

  it("streams new events with ids, a retry hint and heartbeats, and closes at max age", async () => {
    let feed = [item("a", 10)];
    const config = readApiConfig({ SSE_HEARTBEAT_MS: "100", SSE_MAX_AGE_MS: "450", SSE_POLL_MS: "100" });
    const bus = new ActivityBus(async () => feed, 100);
    const app = createApi({ repo: fixtureRepo(), search: { search: async () => [] }, config, bus });
    const res = await app.request("/api/activity/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    setTimeout(() => {
      feed = [item("b", 11), item("a", 10)];
    }, 150);
    const body = await res.text();
    expect(body).toContain("retry: 3000");
    expect(body).toContain("event: activity");
    expect(body).toContain("fees:b");
    expect(body).not.toContain("fees:a");
    expect(body).toContain(": ping");
    const idLine = body.split("\n").find((l) => l.startsWith("id: "))!;
    expect(decodeCursor(idLine.slice(4))).toEqual(activityCursor(item("b", 11)));
  });

  it("resumes from Last-Event-ID, flags gaps and validates the id", async () => {
    const feed = [item("c", 12), item("b", 11), item("a", 10)];
    const config = readApiConfig({ SSE_HEARTBEAT_MS: "100", SSE_MAX_AGE_MS: "150", SSE_POLL_MS: "5000" });
    const bus = new ActivityBus(async () => feed, 5000);
    const app = createApi({ repo: fixtureRepo(), search: { search: async () => [] }, config, bus });
    const last = encodeCursor(activityCursor(item("a", 10)));
    const body = await (await app.request("/api/activity/stream", { headers: { "last-event-id": last } })).text();
    expect(body.indexOf("fees:b")).toBeGreaterThan(-1);
    expect(body.indexOf("fees:b")).toBeLessThan(body.indexOf("fees:c"));
    expect(body).not.toContain("event: reset");
    const bad = await app.request("/api/activity/stream", { headers: { "last-event-id": "zzz" } });
    expect(bad.status).toBe(400);
  });

  it("caps concurrent streams", async () => {
    const config = readApiConfig({ SSE_MAX_CLIENTS: "1", SSE_MAX_AGE_MS: "300", SSE_HEARTBEAT_MS: "100" });
    const bus = new ActivityBus(async () => [], 5000);
    const app = createApi({ repo: fixtureRepo(), search: { search: async () => [] }, config, bus });
    const first = await app.request("/api/activity/stream");
    const second = await app.request("/api/activity/stream");
    expect(second.status).toBe(503);
    await first.text();
    expect((await app.request("/api/activity/stream")).status).toBe(200);
  });
});

beforeEach(() => vi.restoreAllMocks());
