import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { labelRedirect, NOT_FOUND_HTML, patchRuntime, relativizeHtml } from "../scripts/postexport.mjs";

describe("postexport", () => {
  it("rewrites /_next/ to depth-relative paths", () => {
    const html = '<script src="/_next/a.js"></script><link href="/_next/b.css">';
    expect(relativizeHtml(html, 0)).toBe('<script src="./_next/a.js"></script><link href="./_next/b.css">');
    expect(relativizeHtml(html, 1)).toContain('src="../_next/a.js"');
    expect(relativizeHtml('<a href="/causes/">', 1)).toBe('<a href="/causes/">');
  });

  it("derives the webpack public path from the runtime script URL", () => {
    const out = patchRuntime('x.p="/_next/",y');
    expect(out).toContain("document.currentScript");
    expect(out).not.toContain('.p="/_next/"');
  });

  it("keeps the 404 page free of external assets", () => {
    expect(NOT_FOUND_HTML).not.toMatch(/src="|rel="stylesheet"/);
  });
});

const REF = "ab".repeat(32);

/** Runs the generated 404 page's inline script against a fake location; returns the redirect target. */
function run404(pathname: string): { replaced: string | null; home: string } {
  const script = /<script>([\s\S]*)<\/script>/.exec(NOT_FOUND_HTML)?.[1] ?? "";
  let replaced: string | null = null;
  const home = { href: "/" };
  const location = { pathname, replace: (u: string) => (replaced = u) };
  const document = { getElementById: () => home };
  new Function("location", "document", script)(location, document);
  return { replaced, home: home.href };
}

describe("404 plain-DNS label route", () => {
  it.each([
    ["/pepe", "./token/?label=pepe"],
    ["/pepe/", "../token/?label=pepe"],
    ["/Moon-Cat", "./token/?label=moon-cat"],
    [`/bzz/${REF}/pepe`, "./token/?label=pepe"],
    [`/bzz/${REF}/pepe/`, "../token/?label=pepe"],
  ])("%s redirects to %s", (path, target) => {
    expect(labelRedirect(path)).toBe(target);
    expect(run404(path).replaced).toBe(target);
  });

  it.each([
    "/",
    "/a/b",
    "/pepe/extra",
    "/ab",
    "/-pepe",
    "/pepe-",
    "/ab--cd",
    `/${"a".repeat(64)}`,
    "/pe_pe",
    "/launch",
    "/token",
    `/bzz/${REF}/`,
    `/bzz/${REF}/a/b`,
    "/%E0%A4%A",
  ])("%s shows the 404 page", (path) => {
    expect(labelRedirect(path)).toBeNull();
    expect(run404(path).replaced).toBeNull();
  });

  it("still points the home link at the bundle root", () => {
    expect(run404(`/bzz/${REF}/a/b`).home).toBe(`/bzz/${REF}/`);
    expect(run404("/a/b").home).toBe("/");
  });
});
