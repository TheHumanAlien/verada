import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const TEXT_EXT = new Set([
  ".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".json", ".txt", ".map", ".xml", ".webmanifest", ".md", ".rsc",
]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".ogg", ".wav", ".mov", ".pdf", ".zip", ".wasm", ".gz", ".br",
]);

/**
 * Binary files are allowed only under assets/ (the web app's optimised copies), only in these
 * formats and within a size budget. Mirrors apps/web/scripts/verify-export.mjs ASSET_RULES.
 */
export const ASSET_RULES = {
  dir: "assets",
  extensions: new Set([".webp", ".avif", ".svg", ".woff2", ".png"]),
  maxFileBytes: 400 * 1024,
  maxPngBytes: 100 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
} as const;

const kib = (n: number) => `${Math.round(n / 1024)} KB`;

export interface FileEntry { path: string; bytes: number }
export interface ValidationReport {
  root: string;
  files: FileEntry[];
  totalBytes: number;
  errors: string[];
  warnings: string[];
}

export function walk(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const rec = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) rec(full);
      else if (st.isFile()) out.push({ path: relative(root, full).split(sep).join("/"), bytes: st.size });
    }
  };
  rec(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const ROOT_ABS = /\b(?:href|src|action|poster)\s*=\s*["']\/(?!\/)/gi;
const CSS_ROOT_ABS = /url\(\s*["']?\/(?!\/)/gi;

export function validateExport(root: string): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let files: FileEntry[] = [];
  try {
    files = walk(root);
  } catch {
    return { root, files, totalBytes: 0, errors: [`output directory not found: ${root}`], warnings };
  }
  if (files.length === 0) errors.push("output directory is empty");

  const paths = new Set(files.map((f) => f.path));
  if (!paths.has("index.html")) errors.push("missing root index.html");
  if (!paths.has("404.html")) warnings.push("no 404.html; use it as the error document (or the index document for SPA fallback)");

  // Every directory that holds an html page must hold an index.html.
  const htmlDirs = new Set<string>();
  for (const f of files) {
    if (f.path.endsWith(".html")) {
      const i = f.path.lastIndexOf("/");
      htmlDirs.add(i === -1 ? "" : f.path.slice(0, i));
    }
  }
  for (const d of htmlDirs) {
    const idx = d === "" ? "index.html" : `${d}/index.html`;
    if (!paths.has(idx)) errors.push(`directory "${d}" has html but no index.html`);
  }

  let assetBytes = 0;
  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    if (f.path.split("/")[0] === ASSET_RULES.dir) {
      assetBytes += f.bytes;
      if (ASSET_RULES.extensions.has(ext)) {
        if (f.bytes > ASSET_RULES.maxFileBytes) errors.push(`asset over ${kib(ASSET_RULES.maxFileBytes)}: ${f.path}`);
        if (ext === ".png" && f.bytes > ASSET_RULES.maxPngBytes) errors.push(`png over ${kib(ASSET_RULES.maxPngBytes)}: ${f.path}`);
        continue;
      }
      if (BINARY_EXT.has(ext)) {
        errors.push(`asset type not allowed: ${f.path}`);
        continue;
      }
    }
    if (BINARY_EXT.has(ext)) {
      errors.push(`binary asset not allowed: ${f.path}`);
      continue;
    }
    if (!TEXT_EXT.has(ext)) {
      warnings.push(`unrecognised file type, checking contents: ${f.path}`);
    }
    const buf = readFileSync(join(root, f.path));
    if (buf.subarray(0, 8192).includes(0)) {
      errors.push(`file looks binary (NUL bytes): ${f.path}`);
      continue;
    }
    if (ext === ".html" || ext === ".htm") {
      const s = buf.toString("utf8");
      if (ROOT_ABS.test(s)) errors.push(`root-absolute path in ${f.path} (use relative paths)`);
      ROOT_ABS.lastIndex = 0;
    } else if (ext === ".css") {
      const s = buf.toString("utf8");
      if (CSS_ROOT_ABS.test(s)) errors.push(`root-absolute url() in ${f.path}`);
      CSS_ROOT_ABS.lastIndex = 0;
    }
  }

  if (assetBytes > ASSET_RULES.maxTotalBytes) {
    errors.push(`assets/ totals ${kib(assetBytes)}, over the ${kib(ASSET_RULES.maxTotalBytes)} budget`);
  }
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  return { root, files, totalBytes, errors, warnings };
}

/**
 * An asset pack (art published as its own Swarm collection, e.g. stock logos; built by
 * apps/web/scripts/optimize-assets.mjs into apps/web/packs/<name>/). Only images in the asset
 * formats plus the pack's index.json, each within the per-file budget. There is no total budget:
 * the site loads one image at a time from the pack, and the pack is uploaded once, not per release.
 */
export function validatePack(root: string): ValidationReport {
  const files = walk(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (files.length === 0) errors.push("pack is empty (run pnpm --filter @verada/web assets)");
  else if (!files.some((f) => f.path === "index.json")) errors.push("no index.json at the pack root");
  for (const f of files) {
    if (f.path === "index.json") continue;
    const ext = extname(f.path).toLowerCase();
    if (!ASSET_RULES.extensions.has(ext) || ext === ".woff2") {
      errors.push(`not an image in an asset format: ${f.path}`);
      continue;
    }
    if (f.bytes > ASSET_RULES.maxFileBytes) errors.push(`asset over ${kib(ASSET_RULES.maxFileBytes)}: ${f.path}`);
    if (ext === ".png" && f.bytes > ASSET_RULES.maxPngBytes) errors.push(`png over ${kib(ASSET_RULES.maxPngBytes)}: ${f.path}`);
  }
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  return { root, files, totalBytes, errors, warnings };
}

export function sizeReport(r: ValidationReport, top = 10): string {
  const lines = [`files: ${r.files.length}`, `total: ${r.totalBytes} bytes (${(r.totalBytes / 1024).toFixed(1)} KiB)`];
  const big = [...r.files].sort((a, b) => b.bytes - a.bytes).slice(0, top);
  lines.push("largest:");
  for (const f of big) lines.push(`  ${String(f.bytes).padStart(10)}  ${f.path}`);
  return lines.join("\n");
}
