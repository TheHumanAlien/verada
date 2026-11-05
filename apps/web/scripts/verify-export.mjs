// Verifies out/ is publishable to Swarm: no binary assets, an index.html for every
// route, a 404 page, and no root-absolute asset references left in HTML.
// Pass --build to run the export first.
import { execSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");
const appDir = join(root, "src", "app");

if (process.argv.includes("--build")) {
  execSync("pnpm run build", { cwd: root, stdio: "inherit" });
}

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov", ".pdf", ".wasm", ".zip",
]);

function* walk(dir) {
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

/** Routes = every directory under src/app holding a page file, excluding route groups' parens and api. */
function routes(dir = appDir, prefix = "") {
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

const errors = [];
if (!existsSync(out)) {
  console.error("out/ not found. Run `pnpm --filter @verada/web build` first (or pass --build).");
  process.exit(1);
}

let fileCount = 0;
for (const file of walk(out)) {
  fileCount++;
  const rel = relative(out, file);
  if (BINARY_EXT.has(extname(file).toLowerCase())) errors.push(`binary extension: ${rel}`);
  else if (looksBinary(file)) errors.push(`binary content: ${rel}`);
}

const list = routes();
if (list.some((r) => r.startsWith("api"))) errors.push("an api route exists; the export must have no server");
for (const r of list) {
  const index = join(out, r, "index.html");
  if (!existsSync(index)) errors.push(`missing ${join(r, "index.html") || "index.html"}`);
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

if (errors.length) {
  console.error(`verify-export FAILED (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`verify-export OK: ${fileCount} files, routes: ${list.map((r) => `/${r}`).join(", ")}, no binary assets`);
