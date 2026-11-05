import { describe, expect, it, vi } from "vitest";
import { subscribeActivity } from "@/lib/activity-stream";
import { IndexerClient, toPage, toToken } from "@/lib/indexer";
import { loadTokens, type DataDeps } from "@/lib/data";
import { envDefaults } from "@/lib/config";

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const F = (fn: unknown) => fn as typeof fetch;

describe("IndexerClient", () => {
  it("fails over on network errors and 5xx, then sticks to the working URL", async () => {
    const fn = vi.fn(async (url: string) => {
      if (url.startsWith("https://a")) throw new Error("down");
      if (url.startsWith("https://b")) return res({}, 503);
      return res({ items: [{ address: "0x1", name: "N", symbol: "S" }], nextCursor: "n" });
    });
    const c = new IndexerClient(["https://a.test", "https://b.test", "https://c.test"], { fetchImpl: F(fn) });
    const page = await c.tokens({ limit: 5 });
    expect(page.items[0]?.symbol).toBe("S");
    expect(page.nextCursor).toBe("n");
    expect(fn.mock.calls[0]?.[0]).toBe("https://a.test/api/tokens?limit=5");
    fn.mockClear();
    await c.tokens();
    expect(fn.mock.calls[0]?.[0]).toBe("https://c.test/api/tokens");
  });

  it("does not fail over on 404 and maps it to null", async () => {
    const fn = vi.fn(async () => res({}, 404));
    const c = new IndexerClient(["https://a.test", "https://b.test"], { fetchImpl: F(fn) });
    expect(await c.token("0x1")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sends activity filters", async () => {
    const fn = vi.fn(async (_url: string) => res({ items: [{ id: "1", kind: "launch", amount: "10" }] }));
    const c = new IndexerClient(["https://a.test"], { fetchImpl: F(fn) });
    const page = await c.activity({ kind: "fees", token: "0x1", cursor: "x" });
    expect(String(fn.mock.calls[0]?.[0])).toBe("https://a.test/api/activity?kind=fees&token=0x1&cursor=x");
    expect(page.items[0]?.data).toEqual({ amount: "10" });
  });

  it("parses tolerant page shapes", () => {
    expect(toPage([{ address: "0x1" }], toToken).items).toHaveLength(1);
    expect(toPage({ tokens: [{ address: "0x1" }, { bad: 1 }] }, toToken).items).toHaveLength(1);
    expect(toPage(null, toToken)).toEqual({ items: [], nextCursor: null });
  });
});

describe("loadTokens fallback", () => {
  it("uses the indexer, and rethrows its error when the chain fallback also fails", async () => {
    const ok = { indexer: { tokens: async () => ({ items: [{ address: "0x1", name: "", symbol: "" }], nextCursor: null }) }, chain: () => { throw new Error("x"); } } as unknown as DataDeps;
    expect((await loadTokens(envDefaults(), ok)).source).toBe("indexer");
    const down = { indexer: { tokens: async () => { throw new Error("indexer down"); } }, chain: () => { throw new Error("no rpc"); } } as unknown as DataDeps;
    await expect(loadTokens(envDefaults(), down)).rejects.toThrow("indexer down");
  });

  it("falls back to chain reads when the indexer is down", async () => {
    const down = {
      indexer: { tokens: async () => { throw new Error("indexer down"); } },
      chain: () => ({ getLogs: async () => [], readContract: async () => "" }),
    } as unknown as DataDeps;
    const cfg = { ...envDefaults(), factoryAddress: "0x00000000000000000000000000000000000000aa" as const };
    expect(await loadTokens(cfg, down)).toEqual({ data: [], source: "chain" });
  });
});

describe("subscribeActivity", () => {
  it("polls when EventSource is unavailable and only emits new items", async () => {
    vi.useFakeTimers();
    const pages = [[{ id: "1", kind: "launch" }], [{ id: "2", kind: "fees" }, { id: "1", kind: "launch" }]];
    let n = 0;
    const fn = vi.fn(async () => res({ items: pages[Math.min(n++, 1)] }));
    const c = new IndexerClient(["https://a.test"], { fetchImpl: F(fn) });
    const got: string[] = [];
    const stop = subscribeActivity(c, { onItems: (i) => got.push(...i.map((x) => x.id)), pollMs: 1000, eventSourceImpl: undefined });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    vi.useRealTimers();
    expect(got).toEqual(["2"]);
  });

  it("drops from SSE to polling after repeated errors", async () => {
    class FakeES {
      static last: FakeES;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) { FakeES.last = this; }
      listeners: Record<string, (e: MessageEvent) => void> = {};
      addEventListener(t: string, fn: (e: MessageEvent) => void) { this.listeners[t] = fn; }
      close() { this.closed = true; }
    }
    const c = new IndexerClient(["https://a.test"], { fetchImpl: F(async () => res({ items: [] })) });
    const modes: string[] = [];
    const items: string[] = [];
    const stop = subscribeActivity(c, { onItems: (i) => items.push(...i.map((x) => x.id)), onMode: (m) => modes.push(m), maxSseErrors: 2, eventSourceImpl: FakeES as unknown as typeof EventSource });
    expect(FakeES.last.url).toBe("https://a.test/api/activity/stream");
    FakeES.last.listeners.activity?.({ data: JSON.stringify({ id: "9", kind: "vote" }), lastEventId: "9" } as MessageEvent);
    FakeES.last.onerror?.();
    FakeES.last.onerror?.();
    stop();
    expect(items).toEqual(["9"]);
    expect(modes).toEqual(["sse", "polling"]);
    expect(FakeES.last.closed).toBe(true);
  });
});

describe("indexer row shapes", () => {
  it("maps real token, activity and cause rows", async () => {
    const { toToken, toActivity, toCause, label } = await import("@/lib/indexer");
    const t = toToken({ address: "0x1234567890abcdef1234567890abcdef12345678", metadataUri: "bzz://x" });
    expect(t?.metadataURI).toBe("bzz://x");
    expect(label(t!)).toBe("0x1234...5678");
    expect(toActivity({ id: "1", kind: "launch", timestamp: "1700000000" })?.timestamp).toBe(1700000000);
    expect(toCause({ id: "0xa", name: "A", orgId: null, address: null, isDeployed: false })).toMatchObject({ causeId: "0xa", orgId: null });
    expect(toCause({ causeId: "0xb", payout: "0x1", active: true })).toMatchObject({ causeId: "0xb", address: "0x1", isDeployed: true });
  });
});

describe("subscribeActivity named events", () => {
  it("delivers named activity events and re-baselines on reset", async () => {
    class FakeES {
      static last: FakeES;
      onmessage: unknown = null;
      onerror: (() => void) | null = null;
      listeners: Record<string, (e: MessageEvent) => void> = {};
      constructor(readonly url: string) { FakeES.last = this; }
      addEventListener(t: string, fn: (e: MessageEvent) => void) { this.listeners[t] = fn; }
      close() {}
    }
    const fn = vi.fn(async () => res({ items: [{ id: "5", kind: "launch" }] }));
    const c = new IndexerClient(["https://a.test"], { fetchImpl: F(fn) });
    const got: string[] = [];
    const stop = subscribeActivity(c, { onItems: (i) => got.push(...i.map((x) => x.id)), eventSourceImpl: FakeES as unknown as typeof EventSource });
    FakeES.last.listeners.activity?.({ data: JSON.stringify({ id: "7", kind: "fees" }), lastEventId: "7" } as MessageEvent);
    FakeES.last.listeners.reset?.({ data: "{}" } as MessageEvent);
    await new Promise((r) => setTimeout(r, 0));
    FakeES.last.listeners.activity?.({ data: JSON.stringify({ id: "5", kind: "launch" }), lastEventId: "5" } as MessageEvent);
    FakeES.last.listeners.activity?.({ data: JSON.stringify({ id: "8", kind: "vote" }), lastEventId: "8" } as MessageEvent);
    stop();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(got).toEqual(["7", "8"]);
  });
});
