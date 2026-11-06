import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_CATEGORIES, REGIONS } from "@verada/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { expandRoute, expectedAgents, routes, verify } from "../scripts/verify-export.mjs";

const CATALOG = readFileSync(join(__dirname, "..", "..", "..", "packages", "sdk", "src", "catalog.ts"), "utf8");

describe("expectedAgents", () => {
  it("matches the SDK's AGENT_CATEGORIES and REGIONS", () => {
    const { labels, regions } = expectedAgents(CATALOG);
    expect(labels).toEqual(AGENT_CATEGORIES.map((c) => c.ensLabel));
    expect(regions).toEqual(REGIONS.map((r) => r.slug));
    expect(labels).toHaveLength(20);
    expect(regions).toHaveLength(8);
  });

  it("fails loudly when the source no longer parses", () => {
    expect(() => expectedAgents("export const SOMETHING_ELSE = [];")).toThrow();
    expect(() => expectedAgents("export const CATEGORIES = [] as const;\nexport const REGIONS = [] as const;")).toThrow();
  });
});

describe("verify-export", () => {
  let tmp: string;
  let app: string;
  let out: string;
  const touch = (path: string, body = "<html></html>") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  const SMALL = [
    "export const CATEGORIES = [",
    '  { bit: 0, slug: "a-cause", ensLabel: "alpha", ntee: ["A"] },',
    '  { bit: 1, slug: "b-cause", ensLabel: "beta", ntee: [] },',
    '  { bit: 2, slug: "other", ntee: [] },',
    "] as const;",
    "export const REGIONS = [",
    '  { bit: 0, slug: "africa" },',
    '  { bit: 1, slug: "asia" },',
    "] as const;",
  ].join("\n");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "verify-export-"));
    app = join(tmp, "app");
    out = join(tmp, "out");
    for (const page of ["page.tsx", "token/page.tsx", "agent/page.tsx", "agent/[label]/page.tsx", "agent/[label]/[region]/page.tsx"]) {
      touch(join(app, page), "export default function P() {}");
    }
    for (const page of ["index.html", "token/index.html", "agent/index.html", "404.html"]) touch(join(out, page));
    touch(join(out, "config.json"), "{}");
    for (const label of ["alpha", "beta"]) {
      touch(join(out, "agent", label, "index.html"));
      for (const region of ["africa", "asia"]) touch(join(out, "agent", label, region, "index.html"));
    }
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("keeps dynamic segments as patterns", () => {
    expect([...routes(app)].sort()).toEqual(["", "agent", "agent/[label]", "agent/[label]/[region]", "token"]);
  });

  it("expands dynamic segments against the built directories", () => {
    expect(expandRoute("agent/[label]", out)).toEqual({ paths: ["agent/alpha", "agent/beta"], errors: [] });
    expect(expandRoute("agent/[label]/[region]", out).paths).toHaveLength(4);
  });

  it("passes a complete export", () => {
    const r = verify({ out, appDir: app, catalogSource: SMALL });
    expect(r.errors).toEqual([]);
    expect(r.pageCount).toBe(1 + 1 + 1 + 2 + 4);
  });

  it("requires at least one built page for a dynamic segment", () => {
    rmSync(join(out, "agent", "alpha"), { recursive: true });
    rmSync(join(out, "agent", "beta"), { recursive: true });
    const { errors } = verify({ out, appDir: app, catalogSource: SMALL });
    expect(errors).toContain("no built pages for agent/[label] (route agent/[label])");
    expect(errors).toContain("missing agent/alpha/index.html");
  });

  it("checks index.html inside every expanded directory", () => {
    rmSync(join(out, "agent", "beta", "asia", "index.html"));
    expect(verify({ out, appDir: app, catalogSource: SMALL }).errors).toEqual(
      expect.arrayContaining(["missing agent/beta/asia/index.html"]),
    );
  });

  it("reports a missing agent or region directory", () => {
    rmSync(join(out, "agent", "beta", "asia"), { recursive: true });
    expect(verify({ out, appDir: app, catalogSource: SMALL }).errors).toEqual(["missing agent/beta/asia/index.html"]);
  });

  it("reports unexpected agent directories", () => {
    touch(join(out, "agent", "gamma", "index.html"));
    touch(join(out, "agent", "alpha", "mars", "index.html"));
    const { errors } = verify({ out, appDir: app, catalogSource: SMALL });
    expect(errors).toContain("unexpected agent/gamma/ (agent list out of date?)");
    expect(errors).toContain("unexpected agent/alpha/mars/ (region list out of date?)");
  });

  const bytes = (n: number) => Buffer.alloc(n, 1);
  const errorsOf = () => verify({ out, appDir: app, catalogSource: SMALL }).errors;

  it("allows small optimised assets under assets/, and no assets/ at all", () => {
    expect(errorsOf()).toEqual([]);
    touch(join(out, "assets", "logo", "varada.svg"), "<svg/>");
    touch(join(out, "assets", "scenes", "a-960.avif"), bytes(200 * 1024) as unknown as string);
    touch(join(out, "assets", "causes", "hunger-64.webp"), bytes(4 * 1024) as unknown as string);
    touch(join(out, "assets", "fonts", "inter.woff2"), bytes(30 * 1024) as unknown as string);
    touch(join(out, "assets", "logo", "small.png"), bytes(50 * 1024) as unknown as string);
    expect(errorsOf()).toEqual([]);
  });

  it("rejects an oversized asset and a large png", () => {
    touch(join(out, "assets", "scenes", "big.webp"), bytes(401 * 1024) as unknown as string);
    touch(join(out, "assets", "logo", "original.png"), bytes(101 * 1024) as unknown as string);
    expect(errorsOf().sort()).toEqual(["asset over 400 KB: assets/scenes/big.webp (401 KB)", "png over 100 KB: assets/logo/original.png (101 KB)"]);
  });

  it("rejects assets over the total budget", () => {
    for (let i = 0; i < 14; i++) touch(join(out, "assets", "scenes", `s${i}.avif`), bytes(390 * 1024) as unknown as string);
    expect(errorsOf()).toEqual(["assets/ totals 5460 KB, over the 5120 KB budget"]);
  });

  it("rejects disallowed asset types and binaries outside assets/", () => {
    touch(join(out, "assets", "images", "photo.jpg"), bytes(10) as unknown as string);
    touch(join(out, "logo.svg"), "<svg/>");
    touch(join(out, "_next", "blob.bin"), Buffer.from([1, 0, 2]) as unknown as string);
    expect(errorsOf().sort()).toEqual(["asset type not allowed: assets/images/photo.jpg", "binary content: _next/blob.bin", "binary extension: logo.svg"]);
  });
});
