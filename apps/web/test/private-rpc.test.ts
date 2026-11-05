import { describe, expect, it, vi } from "vitest";
import type { PrivateRpcConfig } from "@/lib/config";
import { jsonRpcProvider, PrivateRpc, PrivateRpcUnavailableError, type WorkerLike } from "@/lib/private-rpc";

const cfg: PrivateRpcConfig = { network: "nym", rpcUrls: ["https://rpc.example"] };
const alice = "0x00000000000000000000000000000000000000a1" as const;
const bob = "0x00000000000000000000000000000000000000b2" as const;

function fakeWorker(fail?: Error) {
  const calls: { input: unknown; init: Record<string, unknown> }[] = [];
  const worker: WorkerLike = {
    ready: fail ? Promise.reject(fail) : Promise.resolve(),
    fetch: vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
      calls.push({ input, init: init ?? {} });
      // Answer single and batched JSON-RPC bodies.
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id: number } | { id: number }[]) : { id: 1 };
      const answer = (b: { id: number }) => ({ jsonrpc: "2.0", id: b.id, result: "0x1" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    }) as unknown as WorkerLike["fetch"],
    close: vi.fn(),
  };
  if (fail) worker.ready.catch(() => {});
  return { worker, calls };
}

describe("PrivateRpc", () => {
  it("passes the network's specifier and a bootstrap provider to the worker", async () => {
    const { worker } = fakeWorker();
    const factory = vi.fn().mockResolvedValue(worker);
    const rpc = new PrivateRpc(cfg, { factory });
    await rpc.fetch("https://rpc.example", { method: "POST" });
    const init = factory.mock.calls[0]![0];
    expect(init.address).toBe("0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0");
    expect(typeof init.preExisting.rpcProvider.request).toBe("function");
    expect(rpc.getStatus()).toEqual({ state: "ready" });
  });

  it("uses a separate, stable isolation key per account and for public data", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker });
    await rpc.fetch("u", {}, { kind: "account", address: alice });
    await rpc.fetch("u", {}, { kind: "account", address: bob });
    await rpc.fetch("u", {}, { kind: "account", address: alice });
    await rpc.fetch("u", {}, { kind: "public" });
    const keys = calls.map((c) => (c.init.anonOptions as { isolationKey: string }).isolationKey);
    expect(keys[0]).toBe(keys[2]);
    expect(new Set(keys).size).toBe(3);
    expect(keys.join()).not.toContain(alice.slice(2));
  });

  it("isolates wagmi traffic under the connected account", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker });
    const f = rpc.fetchFor();
    rpc.setAccount(alice);
    await f("u", { method: "POST" });
    expect((calls[0]!.init.anonOptions as { isolationKey: string }).isolationKey).toBe(
      rpc.isolationKey({ kind: "account", address: alice }),
    );
  });

  it("fails closed for account data even when the user allowed direct public reads", async () => {
    const direct = vi.fn().mockResolvedValue(new Response("{}"));
    const rpc = new PrivateRpc(cfg, { factory: async () => fakeWorker(new Error("mixnet down")).worker, directFetch: direct });
    await expect(rpc.fetch("u", {}, { kind: "account", address: alice })).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    expect(rpc.getStatus()).toMatchObject({ state: "failed", message: "mixnet down" });

    rpc.allowDirectForPublic(true);
    await expect(rpc.fetch("u", {}, { kind: "account", address: alice })).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    await rpc.fetch("https://rpc.example", {}, { kind: "public" });
    // The only direct calls are the explicit public opt-in (the bootstrap read is made by the real harness, not this fake).
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("never goes direct for public data unless the user opts in", async () => {
    const direct = vi.fn();
    const rpc = new PrivateRpc(cfg, { factory: async () => fakeWorker(new Error("down")).worker, directFetch: direct });
    await expect(rpc.fetch("u")).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    expect(direct).not.toHaveBeenCalled();
  });

  it("retry replaces a failed worker", async () => {
    const bad = fakeWorker(new Error("down")).worker;
    const good = fakeWorker().worker;
    const factory = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    const rpc = new PrivateRpc(cfg, { factory });
    await expect(rpc.fetch("u")).rejects.toThrow();
    await rpc.retry();
    expect(rpc.getStatus()).toEqual({ state: "ready" });
    await expect(rpc.fetch("u")).resolves.toBeInstanceOf(Response);
  });

  it("drives a viem transport through the worker", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker });
    const { createPublicClient } = await import("viem");
    const { mainnet } = await import("viem/chains");
    const client = createPublicClient({ chain: mainnet, transport: rpc.transport({ kind: "public" }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(1n);
    expect(String(calls[0]!.input)).toMatch(/^https:\/\/rpc\.example\/?$/);
    expect(calls[0]!.init).not.toHaveProperty("url");
  });
});

describe("jsonRpcProvider", () => {
  it("posts JSON-RPC without credentials and unwraps the result", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" })));
    const p = jsonRpcProvider("https://boot.example", f as unknown as typeof fetch);
    expect(await p.request({ method: "eth_call", params: [{}] })).toBe("0xabc");
    expect(f.mock.calls[0]![1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });
});
