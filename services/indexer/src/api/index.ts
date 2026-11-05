import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { and, asc, desc, eq, graphql, isNotNull, replaceBigInts } from "ponder";
import { createApi } from "./routes";
import { readApiConfig } from "./config";
import { repo } from "./repo";
import { swarmReportFetcher } from "./agents";
import { agentsRepo } from "./agents-repo";
import { createCatalogStore } from "./catalog";
import { createCauseSearch } from "./search";

// The namespace carries a `default` interop key that breaks GraphQL schema building.
const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const {
  token,
  feeTotal,
  cause,
  epoch,
  donation,
  feeConsolidation,
  consolidationFailure,
  consolidationTotal,
  quoteAsset,
  orgDeployment,
} = schema;

const config = readApiConfig(process.env);

// Browser-facing, versioned routes (/api/*) with CORS, rate limits and validation. The legacy
// routes below are mounted on the same app so they share CORS and the rate limiter.
const app = createApi({
  repo,
  config,
  search: createCauseSearch({
    baseUrl: config.endaomentBaseUrl,
    apiKey: config.endaomentApiKey,
    ttlMs: config.searchCacheTtlMs,
    maxEntries: config.searchCacheMaxEntries,
  }),
  catalog: createCatalogStore(config.catalogSource, { log: (m) => console.info(m) }),
  agents: agentsRepo,
  reports: swarmReportFetcher(config.swarmGatewayUrl),
});

const json = (v: unknown) => replaceBigInts(v, (b) => b.toString());

function page(c: { req: { query: (k: string) => string | undefined } }) {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  return { limit, offset };
}

const isAddr = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

app.use("/graphql", graphql({ db, schema }));

app.get("/tokens", async (c) => {
  const { limit, offset } = page(c);
  const creator = c.req.query("creator")?.toLowerCase();
  const rows = await db
    .select()
    .from(token)
    .where(creator && isAddr(creator) ? eq(token.creator, creator) : undefined)
    .orderBy(desc(token.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

app.get("/tokens/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!isAddr(address)) return c.json({ error: "invalid address" }, 400);
  const [row] = await db.select().from(token).where(eq(token.address, address)).limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  // One row per token: all amounts are settlement-asset (USDC, 6 decimals) base units.
  const [fees] = await db.select().from(feeTotal).where(eq(feeTotal.token, address)).limit(1);
  const consolidation = await db
    .select()
    .from(consolidationTotal)
    .where(eq(consolidationTotal.token, address));
  const epochs = await db
    .select()
    .from(epoch)
    .where(eq(epoch.token, address))
    .orderBy(desc(epoch.epoch));
  return c.json(json({ ...row, feeTotals: fees ?? null, consolidation, epochs }));
});

app.get("/tokens/:address/epochs", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!isAddr(address)) return c.json({ error: "invalid address" }, 400);
  const rows = await db
    .select()
    .from(epoch)
    .where(eq(epoch.token, address))
    .orderBy(desc(epoch.epoch));
  return c.json(json({ items: rows }));
});

app.get("/causes", async (c) => {
  const active = c.req.query("active");
  const rows = await db
    .select()
    .from(cause)
    .where(active === undefined ? undefined : eq(cause.active, active === "true"))
    .orderBy(asc(cause.addedAt));
  return c.json(json({ items: rows }));
});

app.get("/epochs", async (c) => {
  const { limit, offset } = page(c);
  const t = c.req.query("token")?.toLowerCase();
  const rows = await db
    .select()
    .from(epoch)
    .where(t && isAddr(t) ? eq(epoch.token, t) : undefined)
    .orderBy(desc(epoch.epoch))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

/** Finalized epochs with their winning cause and any donation made. */
app.get("/winners", async (c) => {
  const { limit, offset } = page(c);
  const t = c.req.query("token")?.toLowerCase();
  const rows = await db
    .select({ epoch, cause })
    .from(epoch)
    .innerJoin(cause, eq(epoch.winningCauseId, cause.causeId))
    .where(and(isNotNull(epoch.winningCauseId), t && isAddr(t) ? eq(epoch.token, t) : undefined))
    .orderBy(desc(epoch.finalizedAt))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

app.get("/donations", async (c) => {
  const { limit, offset } = page(c);
  const t = c.req.query("token")?.toLowerCase();
  const rows = await db
    .select()
    .from(donation)
    .where(t && isAddr(t) ? eq(donation.token, t) : undefined)
    .orderBy(desc(donation.timestamp))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

/** Accrued fees in USDC base units (6 decimals) for a token. */
app.get("/tokens/:address/fees", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!isAddr(address)) return c.json({ error: "invalid address" }, 400);
  const [totals] = await db.select().from(feeTotal).where(eq(feeTotal.token, address)).limit(1);
  const consolidation = await db
    .select()
    .from(consolidationTotal)
    .where(eq(consolidationTotal.token, address));
  return c.json(json({ decimals: 6, totals: totals ?? null, consolidation }));
});

app.get("/consolidations", async (c) => {
  const { limit, offset } = page(c);
  const t = c.req.query("token")?.toLowerCase();
  const rows = await db
    .select()
    .from(feeConsolidation)
    .where(t && isAddr(t) ? eq(feeConsolidation.token, t) : undefined)
    .orderBy(desc(feeConsolidation.timestamp))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

app.get("/consolidation-failures", async (c) => {
  const { limit, offset } = page(c);
  const t = c.req.query("token")?.toLowerCase();
  const rows = await db
    .select()
    .from(consolidationFailure)
    .where(t && isAddr(t) ? eq(consolidationFailure.token, t) : undefined)
    .orderBy(desc(consolidationFailure.timestamp))
    .limit(limit)
    .offset(offset);
  return c.json(json({ items: rows, limit, offset }));
});

app.get("/quote-assets", async (c) => {
  const active = c.req.query("active");
  const rows = await db
    .select()
    .from(quoteAsset)
    .where(active === undefined ? undefined : eq(quoteAsset.active, active === "true"))
    .orderBy(asc(quoteAsset.addedAt));
  return c.json(json({ items: rows }));
});

app.get("/orgs", async (c) => {
  const rows = await db.select().from(orgDeployment).orderBy(desc(orgDeployment.deployedAt));
  return c.json(json({ items: rows }));
});

// /health, /ready, /status and /metrics are served by Ponder itself.

export default app;
