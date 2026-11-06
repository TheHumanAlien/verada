import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, SafeLink, markdownHeadingLevel, parseInline, parseMarkdown, safeHttpUrl } from "@/lib/markdown";

const html = (source: string) => render(<Markdown source={source} />).container;

describe("safeHttpUrl", () => {
  it.each([
    ["https://example.org/a?b=1", "https://example.org/a?b=1"],
    ["HTTP://Example.org", "http://example.org/"],
    ["javascript:alert(1)", null],
    ["JaVaScRiPt:alert(1)", null],
    [" javascript:alert(1)", null],
    ["data:text/html,<script>alert(1)</script>", null],
    ["vbscript:x", null],
    ["//evil.test", null],
    ["/relative", null],
    ["https://user:pw@evil.test", null],
    ["https://good.test@evil.test", null],
    ["", null],
  ])("%j -> %j", (input, expected) => {
    expect(safeHttpUrl(input)).toBe(expected);
  });
});

describe("parseMarkdown", () => {
  it("parses headings, paragraphs and lists", () => {
    const blocks = parseMarkdown("# Title\n\nline one\nline two\n\n- a\n- **b**\n\n#### not a heading");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "paragraph"]);
    expect(blocks[1]).toEqual({ type: "paragraph", children: [{ type: "text", text: "line one line two" }] });
  });

  it("keeps unsafe links as literal text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "[x](javascript:alert(1))" }]);
  });
});

describe("Markdown", () => {
  it("renders the safe subset", () => {
    const c = html("# Week\n\n## Africa\n\n### Floods\n\nSome **bold**, *italic* and `code`. See [the report](https://news.test/x).\n\n- one\n- two");
    expect(c.querySelector("h3")?.textContent).toBe("Week");
    expect(c.querySelector("h4")?.textContent).toBe("Africa");
    expect(c.querySelector("h5")?.textContent).toBe("Floods");
    expect(c.querySelector("strong")?.textContent).toBe("bold");
    expect(c.querySelector("em")?.textContent).toBe("italic");
    expect(c.querySelector("code")?.textContent).toBe("code");
    const a = c.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://news.test/x");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(c.querySelectorAll("li")).toHaveLength(2);
  });

  it("never turns javascript: or other unsafe links into anchors", () => {
    const c = html("[click](javascript:alert(1)) [d](data:text/html,x) [r](/x) [p](//evil.test)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("[click](javascript:alert(1))");
  });

  it("renders raw HTML as inert text", () => {
    const src = '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<a href="javascript:alert(1)">x</a> <b onclick="x()">b</b>';
    const c = html(src);
    expect(c.querySelector("script, img, b, a, [onerror], [onclick]")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(c.innerHTML).toContain("&lt;script&gt;");
  });

  it("does not let markup inside link text or emphasis escape", () => {
    const c = html('**<i onmouseover="x">hi</i>** [<script>](https://ok.test)');
    expect(c.querySelector("i, script")).toBeNull();
    expect(c.querySelector("strong")?.textContent).toBe('<i onmouseover="x">hi</i>');
    expect(c.querySelector("a")?.textContent).toBe("<script>");
  });

  it("supports backslash escapes and leaves stray markers alone", () => {
    const c = html("2 * 3 * 4 and \\*not italic\\* and `unclosed");
    expect(c.querySelector("em, code")).toBeNull();
    expect(c.textContent).toBe("2 * 3 * 4 and *not italic* and `unclosed");
  });

  it("handles long pathological input quickly", () => {
    const t = Date.now();
    parseMarkdown("[".repeat(50_000) + "*a".repeat(20_000) + "**".repeat(10_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("SafeLink", () => {
  it("links safe URLs and shows unsafe ones as text", () => {
    const { container } = render(
      <>
        <SafeLink href="https://ok.test">ok</SafeLink>
        <SafeLink href="javascript:alert(1)" />
      </>,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(container.textContent).toContain("javascript:alert(1)");
  });
});

describe("Markdown heading levels", () => {
  const levels = (node: Parameters<typeof render>[0]) =>
    [...render(node).container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => h.tagName);
  const src = "# One\n\n## Two\n\n### Three";

  it("renders headings strictly below the base level", () => {
    expect(levels(<Markdown source={src} baseLevel={2} />)).toEqual(["H3", "H4", "H5"]);
    expect(levels(<Markdown source={src} baseLevel={4} />)).toEqual(["H5", "H6", "H6"]);
    // Under an h5 (or deeper) everything is an h6, never the base level itself.
    expect(levels(<Markdown source={src} baseLevel={5} />)).toEqual(["H6", "H6", "H6"]);
  });

  it("keeps the older headingLevel form, without the old cap at h4", () => {
    expect(levels(<Markdown source={src} headingLevel={3} />)).toEqual(["H3", "H4", "H5"]);
    // A newsletter under an h4 "Newsletter" heading used to render `#` as an h4 too.
    expect(levels(<Markdown source={src} headingLevel={5} />)).toEqual(["H5", "H6", "H6"]);
    expect(levels(<Markdown source={src} baseLevel={3} headingLevel={2} />)).toEqual(["H4", "H5", "H6"]);
  });

  it("clamps odd bases", () => {
    expect(markdownHeadingLevel(0, 1)).toBe(2);
    expect(markdownHeadingLevel(9, 1)).toBe(6);
    expect(markdownHeadingLevel(Number.NaN, 1)).toBe(3);
    expect(markdownHeadingLevel(2.7, 2)).toBe(4);
  });
});
