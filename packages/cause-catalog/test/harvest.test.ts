import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EndaomentClient } from "@verada/endaoment-client";
import { harvest, loadHarvest } from "../src/harvest.js";

function listing(i: number) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    ein: String(200000000 + i),
    name: `Org ${i}`,
    description: "x".repeat(1000),
    logo: "https://x.invalid/logo.png",
    address: { country: "USA", state: "CA" },
    nteeCode: "B20",
    featuredIndex: 0,
    isCompliant: true,
    lifetimeContributionsUsdc: "0",
    donationsReceived: 0,
    grantsReceived: 0,
    deployments: [{ chainId: 1, contractAddress: "0x000000000000000000000000000000000000beef", isDeployed: false }],
    claimed: false,
  };
}

function fakeApi(total: number, failAt?: number) {
  let calls = 0;
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/v1/orgs/counts") {
      return new Response(JSON.stringify({ counts: [{ nteeCode: "B", orgCount: total }], asOf: "2026-11-05T00:00:00.000Z" }));
    }
    calls++;
    if (failAt !== undefined && calls === failAt) throw new Error("crash");
    const offset = Number(u.searchParams.get("offset"));
    const count = Number(u.searchParams.get("count"));
    const page = Array.from({ length: Math.max(0, Math.min(count, total - offset)) }, (_, i) => listing(offset + i));
    return new Response(JSON.stringify(page));
  });
}

const noSleep = async () => {};

describe("harvest", () => {
  it("pages a partition to the end and strips logos and long descriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harvest-"));
    const client = new EndaomentClient({ fetch: fakeApi(60) as any, cache: null, maxRetries: 0 });
    const state = await harvest({ client, dir, partitions: ["B"], sleep: noSleep });
    expect(state.partitions.B).toEqual({ offset: 60, done: true });
    const orgs = await loadHarvest(dir);
    expect(orgs).toHaveLength(60);
    expect(orgs[0]!.description).toHaveLength(600);
    expect(await readFile(join(dir, "orgs-B.jsonl"), "utf8")).not.toMatch(/logo/);
  });

  it("resumes from the checkpoint after a crash without losing or duplicating orgs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harvest-"));
    const crashing = new EndaomentClient({ fetch: fakeApi(80, 3) as any, cache: null, maxRetries: 0 });
    await expect(harvest({ client: crashing, dir, partitions: ["B"], sleep: noSleep })).rejects.toThrow("crash");
    const client = new EndaomentClient({ fetch: fakeApi(80) as any, cache: null, maxRetries: 0 });
    const state = await harvest({ client, dir, partitions: ["B"], sleep: noSleep });
    expect(state.partitions.B!.done).toBe(true);
    expect(await loadHarvest(dir)).toHaveLength(80);
  });

  it("stops at maxPerPartition for partial crawls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harvest-"));
    const client = new EndaomentClient({ fetch: fakeApi(100) as any, cache: null, maxRetries: 0 });
    const state = await harvest({ client, dir, partitions: ["B"], maxPerPartition: 50, sleep: noSleep });
    expect(state.partitions.B).toEqual({ offset: 50, done: false });
  });
});
