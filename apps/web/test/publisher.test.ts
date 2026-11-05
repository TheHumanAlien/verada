import { describe, expect, it, vi } from "vitest";
import { addToShortlist, ballotOptions, parseContenthashInput } from "@/lib/profile";
import { checkLogoFile, PublisherClient, PublisherError } from "@/lib/publisher";

const REF = "ab".repeat(32);
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A minimal PNG signature built in memory (no binary fixture files). */
function pngBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: "image/png" });
}

describe("PublisherClient", () => {
  it("uploads a logo as multipart field `file` without credentials or referrer", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ reference: REF, bzz: `bzz://${REF}`, url: `https://gw.example/bzz/${REF}/` }));
    const c = new PublisherClient("https://pub.example/", f as unknown as typeof fetch);
    const r = await c.uploadLogo(pngBlob(), "logo.png");
    expect(r.reference).toBe(REF);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://pub.example/uploads/logo");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
    const form = init!.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect([...form.keys()]).toEqual(["file"]);
  });

  it("posts metadata JSON and returns the bzz URI", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ reference: "cd".repeat(32), uri: `bzz://${"cd".repeat(32)}`, url: "u" }));
    const c = new PublisherClient("https://pub.example", f as unknown as typeof fetch);
    const r = await c.uploadMetadata({ name: "N", symbol: "S", logoRef: REF });
    expect(r.uri).toBe(`bzz://${"cd".repeat(32)}`);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ name: "N", symbol: "S", logoRef: REF });
  });

  it("maps error statuses to readable messages", async () => {
    const c = new PublisherClient("https://pub.example", (async () => json({ error: "unsupported_media_type" }, 415)) as unknown as typeof fetch);
    await expect(c.uploadLogo(pngBlob())).rejects.toThrow(/PNG, JPEG or WebP/);
    const down = new PublisherClient("https://pub.example", (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch);
    await expect(down.uploadMetadata({ name: "N", symbol: "S", logoRef: REF })).rejects.toBeInstanceOf(PublisherError);
  });

  it("prechecks logo size and type", () => {
    expect(checkLogoFile({ size: 10, type: "image/png" })).toBeNull();
    expect(checkLogoFile({ size: 3 * 1024 * 1024, type: "image/png" })).toMatch(/2 MiB/);
    expect(checkLogoFile({ size: 10, type: "image/svg+xml" })).toMatch(/PNG/);
    expect(checkLogoFile({ size: 0, type: "image/png" })).toMatch(/empty/);
  });
});

describe("profile helpers", () => {
  it("parses contenthash overrides", () => {
    expect(parseContenthashInput("")).toEqual({ ok: true, value: "0x" });
    expect(parseContenthashInput(`bzz://${REF}`)).toEqual({ ok: true, value: `0xe40101fa011b20${REF}` });
    expect(parseContenthashInput(REF)).toEqual({ ok: true, value: `0xe40101fa011b20${REF}` });
    expect(parseContenthashInput("0xE301")).toEqual({ ok: true, value: "0xe301" });
    expect(parseContenthashInput("ipfs://x").ok).toBe(false);
    expect(parseContenthashInput("0x123").ok).toBe(false);
  });

  it("keeps shortlists distinct and at most 10 long", () => {
    const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
    let list: `0x${string}`[] = [];
    for (let i = 1; i <= 10; i++) list = addToShortlist(list, id(i)) as `0x${string}`[];
    expect(list).toHaveLength(10);
    expect(addToShortlist(list, id(11))).toMatch(/at most 10/);
    expect(addToShortlist([id(1)], id(1))).toMatch(/already/);
    expect(addToShortlist([], "0x12")).toMatch(/32 bytes/);
  });

  it("uses frozen epoch options once opened, else the shortlist, else the default", () => {
    expect(ballotOptions({ opened: true, epochOptions: ["0xa"], shortlist: ["0xb"], defaultShortlist: ["0xc"] })).toEqual({ options: ["0xa"], frozen: true });
    expect(ballotOptions({ opened: false, epochOptions: [], shortlist: ["0xb"], defaultShortlist: ["0xc"] })).toEqual({ options: ["0xb"], frozen: false });
    expect(ballotOptions({ opened: false, epochOptions: [], shortlist: [], defaultShortlist: ["0xc"] })).toEqual({ options: ["0xc"], frozen: false });
  });
});
