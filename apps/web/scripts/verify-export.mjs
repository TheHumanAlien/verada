// Verifies out/ is publishable to Swarm: binaries only as budgeted assets under assets/
// (see ASSET_RULES), an index.html for every
// route (dynamic segments expanded against what the export built), every curator-agent
// page, a 404 page, and no root-absolute asset references left in HTML.
// Pass --build to run the export first.
import { execSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov", ".pdf", ".wasm", ".zip",
]);

const DYNAMIC = /^\[.+\]$/;

/**
 * Binary files are allowed only under out/assets/ (the optimised copies scripts/optimize-assets.mjs
 * writes to public/assets/), only in these formats and within a size budget, so unoptimised
 * originals cannot reach the Swarm bundle. A missing out/assets/ is fine.
 */
export const ASSET_RULES = {
  dir: "assets",
  extensions: new Set([".webp", ".avif", ".svg", ".woff2", ".png"]),
  maxFileBytes: 400 * 1024,
  maxPngBytes: 100 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
};

const kb = (n) => `${Math.round(n / 1024)} KB`;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function looksBinary(file) {
  const size = statSync(file).size;
  if (size === 0) return false;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.includes(0);
  } finally {
    closeSync(fd);
  }
}

function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.startsWith("_") && statSync(join(dir, n)).isDirectory());
}

/**
 * Route patterns = every directory under src/app holding a page file, with route groups' parens
 * dropped and private (`_x`) / parallel (`@x`) folders skipped. Dynamic segments stay as written
 * (`agent/[label]`).
 */
export function routes(dir, prefix = "") {
  const found = [];
  const names = readdirSync(dir);
  if (names.some((n) => /^page\.(tsx|ts|jsx|js)$/.test(n))) found.push(prefix);
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory() && !name.startsWith("_") && !name.startsWith("@")) {
      found.push(...routes(p, name.startsWith("(") ? prefix : `${prefix}${prefix ? "/" : ""}${name}`));
    }
  }
  return [...new Set(found)];
}

/**
 * Expands a route pattern against the export: a dynamic segment matches every built directory at
 * that level and must match at least one. Returns the concrete route paths and any errors.
 */
export function expandRoute(pattern, out) {
  const errors = [];
  let paths = [""];
  for (const seg of pattern ? pattern.split("/") : []) {
    if (!DYNAMIC.test(seg)) {
      paths = paths.map((p) => (p ? `${p}/${seg}` : seg));
      continue;
    }
    const next = [];
    for (const p of paths) {
      const built = subdirs(join(out, p));
      if (built.length === 0) errors.push(`no built pages for ${p ? `${p}/` : ""}${seg} (route ${pattern})`);
      next.push(...built.map((n) => (p ? `${p}/${n}` : n)));
    }
    paths = next;
  }
  return { paths, errors };
}

/** Text between `start` and the first `end` after it, or null. */
function block(src, start, end) {
  const i = src.indexOf(start);
  if (i === -1) return null;
  const j = src.indexOf(end, i);
  return j === -1 ? null : src.slice(i, j);
}

/**
 * Expected agent labels and region slugs, read from the SDK's catalog source (plain node cannot
 * import the TypeScript SDK). Mirrors `AGENT_CATEGORIES` (every category with an `ensLabel`) and
 * `REGIONS`. Throws when either list cannot be read, so a refactor of the source fails loudly.
 */
export function expectedAgents(catalogSource) {
  const cats = block(catalogSource, "export const CATEGORIES", "] as const;");
  const regs = block(catalogSource, "export const REGIONS", "] as const;");
  if (!cats || !regs) throw new Error("cannot find CATEGORIES / REGIONS in the SDK catalog source");
  const labels = [...cats.matchAll(/\bensLabel:\s*"([^"]+)"/g)].map((m) => m[1]);
  const regions = [...regs.matchAll(/\bslug:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (labels.length === 0 || regions.length === 0) throw new Error("no agent labels or regions parsed from the SDK catalog source");
  if (new Set(labels).size !== labels.length || new Set(regions).size !== regions.length) {
    throw new Error("duplicate agent labels or regions parsed from the SDK catalog source");
  }
  return { labels, regions };
}

/** Every agent and agent x region page must exist, and nothing else may sit under agent/. */
export function checkAgentRoutes(out, { labels, regions }) {
  const errors = [];
  const agentDir = join(out, "agent");
  for (const label of labels) {
    if (!existsSync(join(agentDir, label, "index.html"))) errors.push(`missing agent/${label}/index.html`);
    for (const region of regions) {
      if (!existsSync(join(agentDir, label, region, "index.html"))) errors.push(`missing agent/${label}/${region}/index.html`);
    }
    for (const extra of subdirs(join(agentDir, label)).filter((n) => !regions.includes(n))) {
      errors.push(`unexpected agent/${label}/${extra}/ (region list out of date?)`);
    }
  }
  for (const extra of subdirs(agentDir).filter((n) => !labels.includes(n))) {
    errors.push(`unexpected agent/${extra}/ (agent list out of date?)`);
  }
  return errors;
}

/** Runs every check on an export directory. */
export function verify({ out, appDir, catalogSource }) {
  const errors = [];
  let fileCount = 0;
  let assetBytes = 0;
  for (const file of walk(out)) {
    fileCount++;
    const rel = relative(out, file);
    const ext = extname(file).toLowerCase();
    const inAssets = rel.split(/[\\/]/)[0] === ASSET_RULES.dir;
    if (inAssets) {
      const size = statSync(file).size;
      assetBytes += size;
      if (!ASSET_RULES.extensions.has(ext)) {
        if (BINARY_EXT.has(ext) || looksBinary(file)) errors.push(`asset type not allowed: ${rel}`);
        continue;
      }
      if (size > ASSET_RULES.maxFileBytes) errors.push(`asset over ${kb(ASSET_RULES.maxFileBytes)}: ${rel} (${kb(size)})`);
      if (ext === ".png" && size > ASSET_RULES.maxPngBytes) errors.push(`png over ${kb(ASSET_RULES.maxPngBytes)}: ${rel} (${kb(size)})`);
      continue;
    }
    if (BINARY_EXT.has(ext)) errors.push(`binary extension: ${rel}`);
    else if (looksBinary(file)) errors.push(`binary content: ${rel}`);
  }
  if (assetBytes > ASSET_RULES.maxTotalBytes) {
    errors.push(`assets/ totals ${kb(assetBytes)}, over the ${kb(ASSET_RULES.maxTotalBytes)} budget`);
  }

  const patterns = routes(appDir);
  if (patterns.some((r) => r === "api" || r.startsWith("api/"))) errors.push("an api route exists; the export must have no server");
  const pages = [];
  for (const pattern of patterns) {
    const { paths, errors: expandErrors } = expandRoute(pattern, out);
    errors.push(...expandErrors);
    for (const r of paths) {
      pages.push(r);
      if (!existsSync(join(out, r, "index.html"))) errors.push(`missing ${r ? `${r}/` : ""}index.html`);
    }
  }
  if (patterns.some((r) => r === "agent" || r.startsWith("agent/"))) {
    errors.push(...checkAgentRoutes(out, expectedAgents(catalogSource)));
  }
  if (!existsSync(join(out, "404.html"))) errors.push("missing 404.html (Swarm error document)");
  if (!existsSync(join(out, "config.json"))) errors.push("missing config.json");

  for (const file of walk(out)) {
    if (!file.endsWith(".html")) continue;
    const html = readFileSync(file, "utf8");
    if (/(["'(=])\/_next\//.test(html)) errors.push(`root-absolute /_next/ reference in ${relative(out, file)}`);
  }
  for (const file of walk(join(out, "_next"))) {
    if (/\/webpack-[^/]*\.js$/.test(file) && /\.p="\/_next\/"/.test(readFileSync(file, "utf8"))) {
      errors.push(`unpatched absolute public path in ${relative(out, file)}`);
    }
  }
  return { errors, fileCount, patterns, pageCount: pages.length, assetBytes };
}

// Run directly (not imported by tests). Compared as real file URLs so a symlinked or spaced path still runs.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.includes("--build")) {
    execSync("pnpm run build", { cwd: root, stdio: "inherit" });
  }
  const out = join(root, "out");
  if (!existsSync(out)) {
    console.error("out/ not found. Run `pnpm --filter @verada/web build` first (or pass --build).");
    process.exit(1);
  }
  const catalogSource = readFileSync(join(root, "..", "..", "packages", "sdk", "src", "catalog.ts"), "utf8");
  const { errors, fileCount, patterns, pageCount, assetBytes } = verify({ out, appDir: join(root, "src", "app"), catalogSource });
  if (errors.length) {
    console.error(`verify-export FAILED (${errors.length}):\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `verify-export OK: ${fileCount} files, ${pageCount} pages, routes: ${patterns.map((r) => `/${r}`).join(", ")}, assets ${kb(assetBytes)} of ${kb(ASSET_RULES.maxTotalBytes)}`,
  );
}
