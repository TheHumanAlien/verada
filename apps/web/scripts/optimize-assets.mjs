// Builds web copies of the art in assets-src/ and writes src/lib/assets.generated.ts.
//
// Two destinations:
//   - Bundle art (scenes, cut-outs, cause icons, logo) goes to public/assets/ and ships inside the
//     site on Swarm, within the export budget.
//   - Packs (stock logos, and any later large or growing set) go to packs/<name>/ (build output,
//     not tracked). Each pack is uploaded once as its own Swarm collection with
//     `verada-publish upload-pack --dir apps/web/packs/<name>`, and the app loads it at runtime from
//     `<swarmGatewayUrl>/bzz/<ref>/`, the same way it loads token logos. Packs never count against
//     the site budget, and a new site release doesn't re-upload them.
//
// Originals stay in assets-src/ and are never published. Run after adding or changing art:
//   pnpm --filter @verada/web assets
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "assets-src");
const bundleOut = join(root, "public", "assets");
const packsOut = join(root, "packs");
const manifestPath = join(root, "src", "lib", "assets.generated.ts");

/**
 * Bundle groups: source folder → output folder and the variants to emit (never upscaled).
 * Painted art is stipple-heavy, which WebP compresses poorly, so it ships as AVIF (about a third
 * of the size at the same look) with one small WebP fallback for browsers without AVIF.
 * `blur` adds a tiny inline placeholder for art large enough to need one while it loads.
 */
const BUNDLE = [
  {
    dir: "images/background",
    out: "scenes",
    variants: [
      { format: "avif", widths: [640, 1280], quality: 45 },
      { format: "webp", widths: [960], quality: 55 },
    ],
    blur: true,
  },
  {
    dir: "images/foreground",
    out: "cutouts",
    variants: [
      { format: "avif", widths: [320, 640], quality: 55 },
      { format: "webp", widths: [320], quality: 75 },
    ],
  },
  // 128 covers a 64 px chip on high-density screens; 256 is for large cards.
  { dir: "causes", out: "causes", variants: [{ format: "webp", widths: [128, 256], quality: 80 }] },
];
/** Bundle folders copied as they are (vectors). */
const BUNDLE_VECTORS = [{ dir: "logo", out: "logo" }];

/** Packs: published separately to Swarm, loaded at runtime through the gateway. */
const PACKS = [
  { dir: "stocks", name: "stocks", variants: [{ format: "webp", widths: [64, 128], quality: 82 }] },
];

const RASTER = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function files(dir, exts) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => exts.has(extname(n).toLowerCase()))
    .sort();
}

/** Encodes every raster in `from` into `to`; returns { stem: entry }. */
async function rasters(from, to, variants, blur) {
  const out = {};
  for (const name of files(from, RASTER)) {
    const stem = basename(name, extname(name));
    const input = join(from, name);
    const meta = await sharp(input).metadata();
    mkdirSync(to, { recursive: true });
    const entry = { width: meta.width, height: meta.height };
    for (const v of variants) {
      const widths = v.widths.filter((w) => w <= meta.width);
      if (widths.length === 0) widths.push(meta.width);
      for (const w of widths) {
        const img = sharp(input).resize({ width: w, withoutEnlargement: true });
        const encoded =
          v.format === "avif"
            ? img.avif({ quality: v.quality, effort: 6 })
            : img.webp({ quality: v.quality, alphaQuality: 90, effort: 6 });
        await encoded.toFile(join(to, `${stem}-${w}.${v.format}`));
      }
      entry[v.format] = widths;
    }
    if (blur) {
      const tiny = await sharp(input).resize({ width: 24 }).webp({ quality: 40 }).toBuffer();
      entry.blur = `data:image/webp;base64,${tiny.toString("base64")}`;
    }
    out[stem] = entry;
  }
  return out;
}

/** Copies every SVG in `from` into `to`; returns { stem: { vector: true } }. */
function vectors(from, to) {
  const out = {};
  for (const name of files(from, new Set([".svg"]))) {
    mkdirSync(to, { recursive: true });
    copyFileSync(join(from, name), join(to, name));
    out[basename(name, ".svg")] = { vector: true };
  }
  return out;
}

const assets = {};
const packs = {};

for (const g of BUNDLE) rmSync(join(bundleOut, g.out), { recursive: true, force: true });
for (const v of BUNDLE_VECTORS) rmSync(join(bundleOut, v.out), { recursive: true, force: true });
// Earlier layouts kept stock logos in the bundle; make sure none linger there.
rmSync(join(bundleOut, "stocks"), { recursive: true, force: true });
rmSync(packsOut, { recursive: true, force: true });

for (const g of BUNDLE) {
  const r = await rasters(join(src, g.dir), join(bundleOut, g.out), g.variants, g.blur);
  for (const [stem, e] of Object.entries(r)) assets[`${g.out}/${stem}`] = e;
}
for (const v of BUNDLE_VECTORS) {
  const r = vectors(join(src, v.dir), join(bundleOut, v.out));
  for (const [stem, e] of Object.entries(r)) assets[`${v.out}/${stem}`] = e;
}
for (const p of PACKS) {
  const to = join(packsOut, p.name);
  const entries = {
    ...(await rasters(join(src, p.dir), to, p.variants, false)),
    ...vectors(join(src, p.dir), to),
  };
  packs[p.name] = entries;
  if (Object.keys(entries).length) {
    // The pack's own index, served at the collection root.
    writeFileSync(join(to, "index.json"), `${JSON.stringify({ pack: p.name, entries }, null, 2)}\n`);
  }
}

const lines = (obj, indent) =>
  Object.entries(obj)
    .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
const packBody = Object.entries(packs)
  .map(([name, entries]) => `  ${JSON.stringify(name)}: {\n${lines(entries, "    ")}\n  },`)
  .join("\n");

writeFileSync(
  manifestPath,
  `// Generated by scripts/optimize-assets.mjs. Do not edit; run \`pnpm --filter @verada/web assets\`.

export interface RasterAsset {
  width: number;
  height: number;
  /** Widths emitted per format; each file is <key>-<width>.<format>. */
  avif?: number[];
  webp?: number[];
  /** Inline placeholder shown while the image loads. */
  blur?: string;
}
export interface VectorAsset {
  vector: true;
}
export type AssetEntry = RasterAsset | VectorAsset;

/** Art inside the site bundle, at assets/<key>-<width>.<format> or assets/<key>.svg (relative to the site root). */
export const ASSETS = {
${lines(assets, "  ")}
} as const satisfies Record<string, AssetEntry>;

export type AssetKey = keyof typeof ASSETS;

/**
 * Art published as separate Swarm collections and loaded at runtime from
 * <swarmGatewayUrl>/bzz/<assetPacks[pack]>/<name>-<width>.<format> (or <name>.svg).
 */
export const PACKS = {
${packBody}
} as const satisfies Record<string, Record<string, AssetEntry>>;

export type PackName = keyof typeof PACKS;
`,
);

const packCount = Object.values(packs).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`optimize-assets: ${Object.keys(assets).length} bundle assets → public/assets/, ${packCount} pack entries → packs/`);
