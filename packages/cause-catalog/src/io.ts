import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { BuiltCatalog, CatalogMeta, CatalogOrg, Leaf } from "./build.js";
import type { Overrides } from "./classify.js";

/** File names of a published catalogue directory (uploaded to Swarm as one collection). */
export const CATALOG_FILES = { meta: "catalog.json", orgs: "orgs.jsonl", tree: "tree.json" } as const;

export async function writeCatalog(dir: string, c: BuiltCatalog): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CATALOG_FILES.meta), JSON.stringify(c.meta, null, 2));
  await writeFile(join(dir, CATALOG_FILES.orgs), c.orgs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  await writeFile(join(dir, CATALOG_FILES.tree), JSON.stringify(c.tree.dump()));
}

export async function readCatalog(dir: string): Promise<BuiltCatalog> {
  const meta = JSON.parse(await readFile(join(dir, CATALOG_FILES.meta), "utf8")) as CatalogMeta;
  const orgs = (await readFile(join(dir, CATALOG_FILES.orgs), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CatalogOrg);
  const tree = StandardMerkleTree.load<Leaf>(JSON.parse(await readFile(join(dir, CATALOG_FILES.tree), "utf8")));
  if (tree.root !== meta.root) throw new Error(`tree root ${tree.root} does not match catalog.json ${meta.root}`);
  return { meta, orgs, tree };
}

/**
 * Loads a published catalogue from a directory or an http(s) base URL (for example
 * `https://<gateway>/bzz/<swarmRef>`), checking the tree against `catalog.json`'s root.
 */
export async function loadCatalog(source: string, fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<BuiltCatalog> {
  if (!/^https?:\/\//.test(source)) return readCatalog(source);
  const base = source.replace(/\/+$/, "");
  const get = async (name: string) => {
    const res = await fetchFn(`${base}/${name}`);
    if (!res.ok) throw new Error(`catalogue ${name}: HTTP ${res.status}`);
    return res.text();
  };
  const [metaText, orgsText, treeText] = await Promise.all([get(CATALOG_FILES.meta), get(CATALOG_FILES.orgs), get(CATALOG_FILES.tree)]);
  const meta = JSON.parse(metaText) as CatalogMeta;
  const orgs = orgsText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CatalogOrg);
  const tree = StandardMerkleTree.load<Leaf>(JSON.parse(treeText));
  if (tree.root !== meta.root) throw new Error(`tree root ${tree.root} does not match catalog.json ${meta.root}`);
  return { meta, orgs, tree };
}

export async function readOverrides(path: string): Promise<Overrides> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Overrides;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { orgs: {} };
    throw e;
  }
}
