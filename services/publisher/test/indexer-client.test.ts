import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "../src/indexer-client.js";

const TOKEN = "0x000000000000000000000000000000000000AA01" as Hex;
const A = `0x${"ab".repeat(32)}` as Hex;
const B = `0x${"CD".repeat(32)}` as Hex;

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("indexer client: epochOrgIds", () => {
  it("reads optionOrgIds from the epoch detail route, lowercased", async () => {
    const fetch = respond(200, { epoch: "4", options: [], optionOrgIds: [A, B] });
    const c = createIndexerClient("https://api.verada.test/", { fetch: fetch as typeof globalThis.fetch });
    expect(await c.epochOrgIds(TOKEN, 4n)).toEqual([A, B.toLowerCase()]);
    expect(fetch).toHaveBeenCalledWith(`https://api.verada.test/api/epochs/${TOKEN.toLowerCase()}/4`, expect.anything());
  });

  it("is null for an unknown epoch, an empty list or an older indexer without the field", async () => {
    for (const [status, body] of [
      [404, { error: "not_found" }],
      [200, { optionOrgIds: [] }],
      [200, { options: [A] }],
    ] as const) {
      const c = createIndexerClient("https://api.verada.test", { fetch: respond(status, body) as typeof globalThis.fetch });
      expect(await c.epochOrgIds(TOKEN, 4n)).toBeNull();
    }
  });

  it("rejects server errors and malformed ids", async () => {
    const down = createIndexerClient("https://api.verada.test", { fetch: respond(503, {}) as typeof globalThis.fetch });
    await expect(down.epochOrgIds(TOKEN, 4n)).rejects.toThrow(/HTTP 503/);
    const bad = createIndexerClient("https://api.verada.test", { fetch: respond(200, { optionOrgIds: ["0x12"] }) as typeof globalThis.fetch });
    await expect(bad.epochOrgIds(TOKEN, 4n)).rejects.toThrow();
  });
});
