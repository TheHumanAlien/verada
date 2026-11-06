/**
 * A deliberately small, safe Markdown subset for LLM-written agent newsletters (untrusted input):
 * paragraphs, `#`/`##`/`###` headings, `-`/`*`/`+` bullet lists, `**bold**`, `*italic*`,
 * `` `code` `` and `[text](https://...)` links. Everything else, raw HTML included, is shown as
 * literal text. Output is React elements only (no `dangerouslySetInnerHTML`), so text is always
 * escaped, and only absolute http(s) URLs ever become an `href`.
 */
import type { ReactNode } from "react";

/** Inputs longer than this are cut (with an ellipsis) before parsing. */
export const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_DEPTH = 4;

export const SAFE_LINK_REL = "noopener noreferrer nofollow ugc";

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; items: Inline[][] };

/**
 * The URL normalized by the URL parser when it is an absolute http(s) URL without credentials;
 * null otherwise (`javascript:`, `data:`, relative, protocol-relative, `user@host` tricks...).
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.href;
}

const LINK = /\[([^\[\]\n]{1,500})\]\(([^()\s]{1,2048})\)/y;
const ESCAPABLE = "\\`*_[]()#-+!<>";

/** Inline Markdown into tokens; unmatched or unsafe syntax stays literal text. */
export function parseInline(src: string, depth = 0): Inline[] {
  if (depth >= MAX_DEPTH) return src ? [{ type: "text", text: src }] : [];
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2 && src[i + 2] !== " " && src[end - 1] !== " ") {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (c === "*" && src[i + 1] !== "*" && src[i + 1] !== " " && i + 1 < src.length) {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " ") {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(src);
      if (m) {
        const href = safeHttpUrl(m[2]);
        if (href) {
          flush();
          out.push({ type: "link", href, children: parseInline(m[1]!, depth + 1) });
        } else {
          // Unsafe target: the whole construct is shown as typed, never as a link.
          text += m[0];
        }
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const HEADING = /^(#{1,3})[ \t]+(.+?)[ \t#]*$/;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;

/** Block-level parse: blank lines separate paragraphs; a list ends at a blank or non-bullet line. */
export function parseMarkdown(source: string): Block[] {
  let src = typeof source === "string" ? source : "";
  if (src.length > MAX_MARKDOWN_LENGTH) src = `${src.slice(0, MAX_MARKDOWN_LENGTH)}…`;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let items: string[] | null = null;
  const endPara = () => {
    if (para.length) blocks.push({ type: "paragraph", children: parseInline(para.join(" ")) });
    para = [];
  };
  const endList = () => {
    if (items?.length) blocks.push({ type: "list", items: items.map((t) => parseInline(t)) });
    items = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      endPara();
      endList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      endList();
      blocks.push({ type: "heading", level: h[1]!.length as 1 | 2 | 3, children: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      endPara();
      (items ??= []).push(b[1]!.trim());
      continue;
    }
    if (items) {
      // An indented line continues the previous bullet; anything else starts a paragraph.
      if (/^[ \t]/.test(line) && items.length) {
        items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
        continue;
      }
      endList();
    }
    para.push(line.trim());
  }
  endPara();
  endList();
  return blocks;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "code":
        return <code key={i}>{n.text}</code>;
      case "strong":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel={SAFE_LINK_REL}>
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * The HTML level of a Markdown heading of `depth` (1 for `#`) rendered inside a section whose own
 * heading is `h<base>`: always strictly below the base (`#` is `h<base+1>`), capped at `h6`.
 */
export function markdownHeadingLevel(base: number, depth: number): number {
  const b = Number.isFinite(base) ? Math.max(1, Math.min(5, Math.floor(base))) : 2;
  return Math.min(6, b + Math.max(1, Math.floor(depth)));
}

/**
 * Renders the safe subset. `baseLevel` is the level of the heading the Markdown sits under (default
 * 2): `#` renders one level below it, `##` two, `###` three, capped at `h6`, so the newsletter never
 * outranks or matches the page's own outline. `headingLevel` is the older form, the level `#` maps
 * to (`baseLevel = headingLevel - 1`); `baseLevel` wins when both are given.
 */
export function Markdown({
  source,
  className,
  baseLevel,
  headingLevel,
}: {
  source: string;
  className?: string;
  baseLevel?: number;
  headingLevel?: number;
}) {
  const base = baseLevel ?? (headingLevel !== undefined ? headingLevel - 1 : 2);
  return (
    <div className={className}>
      {parseMarkdown(source).map((b, i) => {
        if (b.type === "heading") {
          const Tag = `h${markdownHeadingLevel(base, b.level)}` as HeadingTag;
          return <Tag key={i}>{renderInline(b.children)}</Tag>;
        }
        if (b.type === "list") {
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{renderInline(b.children)}</p>;
      })}
    </div>
  );
}

/**
 * A link to an untrusted URL (report sources, event links): an external `<a>` when `href` is a safe
 * http(s) URL, otherwise the children (or the raw URL) as plain text.
 */
export function SafeLink({ href, children, className }: { href: string | null | undefined; children?: ReactNode; className?: string }) {
  const safe = safeHttpUrl(href);
  const content = children ?? href ?? "";
  if (!safe) return <span className={className}>{content}</span>;
  return (
    <a className={className} href={safe} target="_blank" rel={SAFE_LINK_REL}>
      {content}
    </a>
  );
}
