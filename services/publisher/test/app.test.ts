import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { canonicalJson } from "../src/metadata.js";
import { RateLimiter } from "../src/security.js";
import { createSwarmClient } from "../src/swarm.js";
import { BATCH, config, form, GIF, JPEG, json, PNG, REF, SVG, WEBP } from "./helpers.js";

type Call = { url: string; init: RequestInit };

function setup(over: Record<string, string | undefined> = {}, respond?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond ? respond(call) : json({ reference: REF }, 201);
  });
  const cfg = config(over);
  const swarm = cfg.swarm.gatewayUrl && cfg.swarm.batchId
    ? createSwarmClient({ gatewayUrl: cfg.swarm.gatewayUrl, batchId: cfg.swarm.batchId, authSecret: cfg.swarm.authSecret, stampsUrl: cfg.swarm.stampsUrl, fetch: fetchMock as typeof fetch })
    : undefined;
  const logs: string[] = [];
  const app = createApp({ config: cfg, swarm, log: (level, msg, data) => logs.push(JSON.stringify({ level, msg, ...data })) });
  return { app, calls, logs };
}

const headersOf = (c: Call) => c.init.headers as Record<string, string>;
const bodyText = async (c: Call) => new TextDecoder().decode(c.init.body as Uint8Array);

describe("GET /health", () => {
  it("answers ok", async () => {
    const { app } = setup();
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok", uploads: true });
  });
});

describe("POST /uploads/logo", () => {
  it("uploads with the sniffed type and the gateway headers", async () => {
    const { app, calls, logs } = setup();
    // The declared type and name are ignored: this is a PNG named like a JPEG.
    const r = await app.request("/uploads/logo", { method: "POST", body: form(PNG, "my-secret-name.jpg", "image/jpeg") });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({
      reference: REF,
      bzz: `bzz://${REF}`,
      url: `https://gw.verada.xyz/bzz/${REF}/`,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://gateway.internal:3000/bzz?name=logo.png");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call)).toEqual({
      Authorization: "gateway-secret", // verbatim: swarm-gateway compares it to AUTH_SECRET as is
      "Content-Type": "image/png",
      "swarm-postage-batch-id": BATCH,
      "swarm-pin": "true",
      "swarm-deferred-upload": "false",
    });
    expect(call.init.body).toEqual(PNG);
    expect(logs.join("\n")).not.toContain("my-secret-name");
    expect(logs.join("\n")).not.toContain("gateway-secret");
  });

  it("accepts JPEG and WebP", async () => {
    const { app, calls } = setup();
    expect((await app.request("/uploads/logo", { method: "POST", body: form(JPEG) })).status).toBe(201);
    expect((await app.request("/uploads/logo", { method: "POST", body: form(WEBP) })).status).toBe(201);
    expect(calls.map((c) => [c.url.split("name=")[1], headersOf(c)["Content-Type"]])).toEqual([
      ["logo.jpg", "image/jpeg"],
      ["logo.webp", "image/webp"],
    ]);
  });

  it("rejects SVG and other types with 415, whatever they claim to be", async () => {
    const { app, calls } = setup();
    const svg = await app.request("/uploads/logo", { method: "POST", body: form(SVG, "logo.svg", "image/svg+xml") });
    expect(svg.status).toBe(415);
    const disguised = await app.request("/uploads/logo", { method: "POST", body: form(SVG, "logo.png", "image/png") });
    expect(disguised.status).toBe(415);
    expect((await app.request("/uploads/logo", { method: "POST", body: form(GIF, "a.gif", "image/gif") })).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-multipart bodies with 415", async () => {
    const { app } = setup();
    const r = await app.request("/uploads/logo", { method: "POST", body: PNG as unknown as BodyInit, headers: { "Content-Type": "image/png" } });
    expect(r.status).toBe(415);
  });

  it("rejects oversized files with 413", async () => {
    const { app, calls } = setup();
    const big = new Uint8Array(4097);
    big.set(PNG);
    expect((await app.request("/uploads/logo", { method: "POST", body: form(big) })).status).toBe(413);
    // Far beyond the multipart allowance: stopped by the body limit before parsing.
    const huge = new Uint8Array(64 * 1024);
    huge.set(PNG);
    expect((await app.request("/uploads/logo", { method: "POST", body: form(huge) })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("requires the file field and a non-empty file", async () => {
    const { app } = setup();
    expect((await app.request("/uploads/logo", { method: "POST", body: form(PNG, "a.png", "image/png", "other") })).status).toBe(400);
    expect((await app.request("/uploads/logo", { method: "POST", body: form(new Uint8Array()) })).status).toBe(400);
  });

  it("returns 503 without a gateway and 502 when the gateway fails", async () => {
    const off = setup({ BEE_GATEWAY_URL: undefined });
    expect((await off.app.request("/uploads/logo", { method: "POST", body: form(PNG) })).status).toBe(503);
    const down = setup({}, () => new Response("nope", { status: 500 }));
    expect((await down.app.request("/uploads/logo", { method: "POST", body: form(PNG) })).status).toBe(502);
    const encrypted = setup({}, () => json({ reference: "ab".repeat(64) }, 201));
    expect((await encrypted.app.request("/uploads/logo", { method: "POST", body: form(PNG) })).status).toBe(502);
  });
});

describe("POST /uploads/metadata", () => {
  const meta = {
    symbol: "GOOD",
    name: " Good Token ",
    logoRef: REF.toUpperCase(),
    website: "https://good.example",
    twitter: "goodtoken",
    description: "",
  };
  const post = (app: ReturnType<typeof setup>["app"], body: unknown, type = "application/json") =>
    app.request("/uploads/metadata", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": type } });

  it("stores canonical JSON as metadata.json", async () => {
    const { app, calls } = setup();
    const r = await post(app, meta);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ reference: REF, uri: `bzz://${REF}`, url: `https://gw.verada.xyz/bzz/${REF}/` });
    const call = calls[0]!;
    expect(call.url).toBe("http://gateway.internal:3000/bzz?name=metadata.json");
    expect(headersOf(call)["Content-Type"]).toBe("application/json");
    expect(await bodyText(call)).toBe(
      `{"logoRef":"${REF}","name":"Good Token","symbol":"GOOD","twitter":"goodtoken","website":"https://good.example"}`,
    );
  });

  it("produces identical bytes for reordered input", async () => {
    const { app, calls } = setup();
    await post(app, meta);
    await post(app, Object.fromEntries(Object.entries(meta).reverse()));
    expect(await bodyText(calls[0]!)).toBe(await bodyText(calls[1]!));
  });

  it("checksums an optional launcher address", async () => {
    const { app, calls } = setup();
    await post(app, { ...meta, launcher: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" });
    expect(JSON.parse(await bodyText(calls[0]!)).launcher).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  it("rejects invalid metadata with 400 and issues", async () => {
    const { app, calls } = setup();
    const cases = [
      { ...meta, logoRef: "bzz://nope" },
      { ...meta, name: "" },
      { ...meta, name: "x".repeat(65) },
      { ...meta, website: "javascript:alert(1)" },
      { ...meta, launcher: "0x123" },
      { ...meta, email: "a@b.c" }, // unknown keys are rejected
      { ...meta, twitter: "has space" },
    ];
    for (const body of cases) {
      const r = await post(app, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).issues.length).toBeGreaterThan(0);
    }
    expect((await post(app, "{not json")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects other content types with 415 and big bodies with 413", async () => {
    const { app } = setup();
    expect((await post(app, meta, "text/plain")).status).toBe(415);
    expect((await post(app, { ...meta, description: "x".repeat(4000) })).status).toBe(413);
  });
});

describe("canonicalJson", () => {
  it("sorts keys deeply and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

describe("GET /site", () => {
  it("reports stamp status and feed passthrough", async () => {
    const owner = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const { app, calls } = setup(
      { SITE_FEED_OWNER: owner, SITE_FEED_MANIFEST: "ef".repeat(32), BEE_STAMPS_URL: "http://bee.internal:1633" },
      () => json({ batchID: BATCH, utilization: 4, usable: true, depth: 20, amount: "1000", bucketDepth: 16, batchTTL: 90 * 86_400, immutableFlag: true }),
    );
    const r = await app.request("/site");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(calls[0]!.url).toBe(`http://bee.internal:1633/stamps/${BATCH}`);
    expect(body).toMatchObject({
      gateway: "https://gw.verada.xyz",
      batchId: BATCH,
      feedOwner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      feedManifest: "ef".repeat(32),
      stamp: { usable: true, ttlDays: 90, utilizationRatio: 0.25, immutable: true },
    });
  });

  it("degrades when the stamp lookup fails", async () => {
    const { app } = setup({}, () => new Response("", { status: 404 }));
    expect(await (await app.request("/site")).json()).toMatchObject({ stamp: null, stampError: "unavailable" });
  });
});

describe("security", () => {
  it("reflects allowed origins, including wildcards, and omits CORS for others", async () => {
    const { app } = setup({ CORS_ALLOWED_ORIGINS: "https://varada.eth.limo,https://*.eth.limo" });
    const ok = await app.request("/health", { headers: { Origin: "https://pepe.varada.eth.limo" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://pepe.varada.eth.limo");
    const bad = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const http = await app.request("/health", { headers: { Origin: "http://x.eth.limo" } });
    expect(http.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers preflight for POST and refuses disallowed origins", async () => {
    const { app } = setup({ CORS_ALLOWED_ORIGINS: "https://*.eth.limo" });
    const pre = await app.request("/uploads/metadata", { method: "OPTIONS", headers: { Origin: "https://a.eth.limo", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("https://a.eth.limo");
    const denied = await app.request("/uploads/metadata", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(denied.status).toBe(403);
  });

  it("allows any origin with an empty allowlist", async () => {
    const { app } = setup();
    const r = await app.request("/health", { headers: { Origin: "https://anything.example" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rate limits uploads per client IP", async () => {
    let t = 0;
    const cfg = config();
    const app = createApp({ config: cfg, limiter: new RateLimiter(1, 2, () => t), log: () => {} });
    const hit = (ip: string) => app.request("/uploads/metadata", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip } });
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    const limited = await hit("1.1.1.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");
    expect((await hit("2.2.2.2")).status).not.toBe(429);
    t += 1000;
    expect((await hit("1.1.1.1")).status).not.toBe(429);
  });

  it("rejects other methods with 405", async () => {
    const { app } = setup();
    const r = await app.request("/uploads/logo", { method: "PUT" });
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe("GET, HEAD, POST, OPTIONS");
  });
});
