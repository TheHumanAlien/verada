import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { NOT_FOUND_HTML, patchRuntime, relativizeHtml } from "../scripts/postexport.mjs";

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
