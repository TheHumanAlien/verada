import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog, verifyEntryProof, writeCatalog, type HarvestedOrg } from "@verada/cause-catalog";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import { catalogStoreOf, createCatalogStore } from "../src/api/catalog";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "./api.fixtures";

const org = (i: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(400000000 + i),
  name: `Org ${i}`,
  description: null,
  nteeCode: "K31",
  country: "USA",
  state: "NY",
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});

const { catalog } = buildCatalog([
  org(1, { name: "Nairobi Feeding Program", nteeCode: "Z00", country: "KEN", description: "feeding program for children" }),
  org(2, { name: "City Food Bank" }),
  org(3, { name: "Rhino Rescue", nteeCode: "D31", country: "ZAF" }),
  org(4, { name: "Shelter House", nteeCode: "L41" }),
]);

const mkApp = (store = catalogStoreOf(catalog)) => {
  const config = readApiConfig({});
  const repo = fixtureRepo();
  const bus = new ActivityBus(() => repo.listActivity({ limit: 100 }), 10_000);
  return createApi({ repo, search: { search: async () => [] }, config, bus, catalog: store });
};
const json = async (app: ReturnType<typeof createApi>, path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: await r.json() };
};

describe("catalogue API", () => {
  it("summarises the catalogue with per-category and per-region counts", async () => {
    const { status, body } = await json(mkApp(), "/api/catalog");
    expect(status).toBe(200);
    expect(body.root).toBe(catalog.meta.root);
    expect(body.orgs).toBe(4);
    expect(body.categories.find((c: any) => c.slug === "hunger").orgs).toBe(2);
    expect(body.regions.find((r: any) => r.slug === "africa").orgs).toBe(2);
  });

  it("searches by name, category and region with paging", async () => {
    const app = mkApp();
    const hungerAfrica = (await json(app, "/api/catalog/search?categories=hunger&regions=africa")).body;
    expect(hungerAfrica.total).toBe(1);
    expect(hungerAfrica.items[0].name).toBe("Nairobi Feeding Program");
    expect(hungerAfrica.items[0]).not.toHaveProperty("description");
    const byName = (await json(app, "/api/catalog/search?q=rhino")).body;
    expect(byName.items.map((o: any) => o.name)).toEqual(["Rhino Rescue"]);
    const paged = (await json(app, "/api/catalog/search?limit=1&offset=1")).body;
    expect(paged.total).toBe(4);
    expect(paged.items).toHaveLength(1);
    const bad = await json(app, "/api/catalog/search?categories=nope");
    expect(bad.status).toBe(400);
  });

  it("reports focus pools and serves entries with proofs that verify against the root", async () => {
    const app = mkApp();
    const pool = (await json(app, "/api/catalog/pool?categories=hunger,children-youth&regions=africa,north-america")).body;
    expect(pool.poolSize).toBe(3);
    expect(pool.buckets.map((b: any) => `${b.category}/${b.region}`)).toEqual([
      "hunger/africa",
      "hunger/north-america",
      "children-youth/africa",
    ]);
    const at = pool.buckets.map((b: any) => `${b.bucket}:0`).join(",");
    const entries = (await json(app, `/api/catalog/entries?at=${at},999:0`)).body;
    expect(entries.items).toHaveLength(3);
    for (const e of entries.items) {
      expect(verifyEntryProof(entries.root, e, e.proof)).toBe(true);
    }
    expect((await json(app, "/api/catalog/entries?at=x")).status).toBe(400);
  });

  it("looks up an org by EIN, org id or Endaoment id", async () => {
    const app = mkApp();
    const byEin = (await json(app, "/api/catalog/orgs/40-0000001")).body;
    expect(byEin.org.name).toBe("Nairobi Feeding Program");
    expect(byEin.entries.length).toBe(2); // hunger and children, Africa
    const byId = (await json(app, `/api/catalog/orgs/${byEin.org.orgId}`)).body;
    expect(byId.org.ein).toBe("400000001");
    expect((await json(app, "/api/catalog/orgs/00000000-0000-0000-0000-000000000003")).body.org.name).toBe("Rhino Rescue");
    expect((await json(app, "/api/catalog/orgs/99-9999999")).status).toBe(404);
    expect((await json(app, "/api/catalog/orgs/nope")).status).toBe(400);
  });

  it("names catalogue orgs by cause id", async () => {
    const app = mkApp();
    const ids = catalog.orgs.slice(0, 2).map((o) => o.causeId);
    const r = (await json(app, `/api/catalog/causes?ids=${ids.join(",")},0x${"00".repeat(32)}`)).body;
    expect(r.items.map((o: any) => o.causeId)).toEqual(ids);
    expect((await json(app, `/api/catalog/orgs/${ids[0]}`)).body.org.causeId).toBe(ids[0]);
    expect((await json(app, "/api/catalog/causes?ids=nope")).status).toBe(400);
  });

  it("answers 503 without a catalogue", async () => {
    const app = mkApp(catalogStoreOf(null));
    for (const p of ["/api/catalog", "/api/catalog/search", "/api/catalog/pool", "/api/catalog/entries?at=1:0", "/api/catalog/orgs/40-0000001", `/api/catalog/causes?ids=0x${"11".repeat(32)}`]) {
      expect((await json(app, p)).status).toBe(503);
    }
  });

  it("loads from a directory in the background", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-"));
    await writeCatalog(dir, catalog);
    const store = createCatalogStore(dir);
    await store.ready;
    expect(store.catalog()?.meta.root).toBe(catalog.meta.root);
    const missing = createCatalogStore(join(dir, "missing"), { log: () => {} });
    await missing.ready;
    expect(missing.catalog()).toBeNull();
  });
});
