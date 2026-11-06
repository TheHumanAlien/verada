import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { agentByLabel, categoryMaskOf, regionBySlug, regionMaskOf } from "@verada/sdk";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { verifyReport, type AgentRow, type AgentsRepo, type ReportFetcher, type StoredReport } from "./agents";
import type { CatalogStore } from "./catalog";
import type { PaidRoute, X402Config } from "./config";

/**
 * Paid data over x402 (v2, `exact` scheme, USDC). Picks, proofs and reports stay free and public
 * (the dApp and anyone verifying a ballot need them); what is sold here is convenience and depth:
 * ranked lists with reasons and sources, the full history, the classified catalogue and the
 * newsletter archive, as machine-readable JSON.
 *
 * Every route accepts USDC on Base (settled by Coinbase CDP) and on Ethereum mainnet (settled by
 * the publisher's own facilitator, since CDP does not cover mainnet). `payTo` is always a
 * platform treasury. A handler that answers 4xx/5xx cancels the payment, so a buyer is never
 * charged for a miss.
 */

export const X402_PREFIX = "/x402/v1";

const ROUTES: Record<PaidRoute, { pattern: string; description: string }> = {
  rankings: {
    pattern: `GET ${X402_PREFIX}/rankings/:label/:region`,
    description: "This week's ranked charities for one cause and region, with scores, reasons, sources and the week's events.",
  },
  history: {
    pattern: `GET ${X402_PREFIX}/history/:label`,
    description: "Every published ranking for one cause, all regions, newest first.",
  },
  catalog: {
    pattern: `GET ${X402_PREFIX}/catalog/export`,
    description: "The classified Endaoment cause catalogue (cause and region tags, bucket entries), filterable and paged.",
  },
  newsletters: {
    pattern: `GET ${X402_PREFIX}/newsletters/:label`,
    description: "The weekly newsletter archive for one cause agent.",
  },
};

export interface X402Deps {
  config: X402Config;
  /** Injected in tests; built from config otherwise. */
  facilitators?: FacilitatorClient[];
  agents?: AgentsRepo;
  reports?: ReportFetcher;
  catalog?: CatalogStore;
  ensParentName: string;
  serialize: (v: unknown) => string;
}

/** `max(price, min)` for mainnet, as decimal strings with up to 6 places. */
export function mainnetPrice(price: string, min: string): string {
  const micros = (s: string) => {
    const [i = "0", f = ""] = s.split(".");
    return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  };
  return micros(price) >= micros(min) ? price : min;
}

/** The `accepts` list for one route: Base first (cheapest to settle), then mainnet. */
export function paymentOptions(config: X402Config, route: PaidRoute) {
  const price = config.prices[route];
  const out: { scheme: "exact"; network: `${string}:${string}`; price: string; payTo: string; maxTimeoutSeconds: number }[] = [];
  if (config.base) {
    out.push({ scheme: "exact", network: config.base.network as `${string}:${string}`, price: `$${price}`, payTo: config.base.payTo, maxTimeoutSeconds: 120 });
  }
  if (config.mainnet) {
    out.push({
      scheme: "exact",
      network: config.mainnet.network as `${string}:${string}`,
      price: `$${mainnetPrice(price, config.mainnetMinPrice)}`,
      payTo: config.mainnet.payTo,
      maxTimeoutSeconds: 300,
    });
  }
  return out;
}

export function routesConfig(config: X402Config): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const [key, r] of Object.entries(ROUTES) as [PaidRoute, (typeof ROUTES)[PaidRoute]][]) {
    routes[r.pattern] = {
      accepts: paymentOptions(config, key),
      description: r.description,
      mimeType: "application/json",
      serviceName: "Verada cause data",
    };
  }
  return routes;
}

export function facilitatorsOf(config: X402Config): FacilitatorClient[] {
  const out: FacilitatorClient[] = [];
  if (config.base) {
    const b = config.base;
    out.push(
      new HTTPFacilitatorClient(
        b.facilitatorUrl ? { url: b.facilitatorUrl } : createFacilitatorConfig(b.cdpKeyId, b.cdpKeySecret),
      ),
    );
  }
  if (config.mainnet) {
    const m = config.mainnet;
    const auth = m.facilitatorToken ? { Authorization: `Bearer ${m.facilitatorToken}` } : undefined;
    out.push(
      new HTTPFacilitatorClient({
        url: m.facilitatorUrl,
        createAuthHeaders: auth ? async () => ({ verify: auth, settle: auth, supported: auth }) : undefined,
      }),
    );
  }
  return out;
}

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(260).default(52) });
const ExportQuery = z.object({
  category: z.string().optional(),
  region: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

/** Mounts the free price list and, when enabled, the paid routes. Disabled: everything 404s. */
export function mountX402(app: Hono, deps: X402Deps): void {
  const { config } = deps;
  if (!config.enabled) return;

  const json = (c: Context, body: unknown, status: 200 | 400 | 404 | 503 = 200) => {
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "private, no-store");
    return c.body(deps.serialize(body), status);
  };
  const fail = (c: Context, status: 400 | 404 | 503, error: string) => json(c, { error }, status);

  // Free: what is for sale and at what price.
  app.get(X402_PREFIX, (c) =>
    json(c, {
      x402Version: 2,
      routes: (Object.entries(ROUTES) as [PaidRoute, (typeof ROUTES)[PaidRoute]][]).map(([key, r]) => ({
        route: r.pattern,
        description: r.description,
        accepts: paymentOptions(config, key),
      })),
      free: ["/api/agents", "/api/agents/:label/reports/:epoch", "/api/agents/:label/picks/:epoch/:region", "/api/catalog/*"],
    }),
  );

  const server = new x402ResourceServer(deps.facilitators ?? facilitatorsOf(config));
  if (config.base) server.register(config.base.network as `${string}:${string}`, new ExactEvmScheme());
  if (config.mainnet) server.register(config.mainnet.network as `${string}:${string}`, new ExactEvmScheme());
  // Only paid paths go through the middleware; the price list above stays free.
  app.use(`${X402_PREFIX}/*`, paymentMiddleware(routesConfig(config), server));

  const agentOf = async (c: Context): Promise<{ agent: AgentRow } | { res: Response }> => {
    if (!deps.agents || !deps.reports) return { res: fail(c, 503, "agents_unavailable") };
    const def = agentByLabel(c.req.param("label") ?? "");
    if (!def) return { res: fail(c, 400, "unknown_agent") };
    const agent = await deps.agents.getAgentByLabel(def.ensLabel);
    if (!agent) return { res: fail(c, 404, "not_found") };
    return { agent };
  };
  const loadAll = async (agent: AgentRow, limit: number) => {
    const rows = await deps.agents!.reports(agent.categoryBit, limit);
    const loaded = await Promise.all(
      rows.map(async (row) => {
        const stored = await deps.reports!.get(row.reportRef);
        return stored ? { row, stored } : null;
      }),
    );
    return loaded.filter((x): x is { row: (typeof rows)[number]; stored: StoredReport } => x !== null);
  };
  const agentHeader = (a: AgentRow) => ({
    label: a.label,
    ensName: `${a.label}.agent.${deps.ensParentName}`,
    agentId: a.agentId,
    vault: a.vault,
  });

  app.get(`${X402_PREFIX}/rankings/:label/:region`, async (c) => {
    let region: { slug: string; bit: number };
    try {
      region = regionBySlug(c.req.param("region"));
    } catch {
      return fail(c, 400, "unknown_region");
    }
    const a = await agentOf(c);
    if ("res" in a) return a.res;
    const [latest] = await loadAll(a.agent, 1);
    if (!latest) return fail(c, 404, "no_report");
    const curations = await deps.agents!.curations(a.agent.categoryBit, latest.row.epoch);
    const section = verifyReport(latest.stored, curations).find((r) => r.region === region.slug);
    if (!section) return fail(c, 404, "no_ranking");
    return json(c, {
      agent: agentHeader(a.agent),
      epoch: latest.row.epoch,
      catalogVersion: latest.row.catalogVersion,
      reportRef: latest.row.reportRef,
      generatedAt: latest.stored.report.generatedAt,
      ...section,
      picks: section.picks.map((p, rank) => ({ rank, ...p })),
    });
  });

  app.get(`${X402_PREFIX}/history/:label`, async (c) => {
    const q = LimitQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_query");
    const a = await agentOf(c);
    if ("res" in a) return a.res;
    const all = await loadAll(a.agent, q.data.limit);
    return json(c, {
      agent: agentHeader(a.agent),
      epochs: all.map(({ row, stored }) => ({
        epoch: row.epoch,
        catalogVersion: row.catalogVersion,
        reportRef: row.reportRef,
        generatedAt: stored.report.generatedAt,
        regions: stored.report.regions.map((r) => ({
          region: r.region,
          weight: r.weight,
          picks: r.picks.map((p, rank) => ({ rank, orgId: p.orgId, catalogIndex: p.catalogIndex, name: p.name, score: p.score })),
        })),
      })),
    });
  });

  app.get(`${X402_PREFIX}/newsletters/:label`, async (c) => {
    const q = LimitQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_query");
    const a = await agentOf(c);
    if ("res" in a) return a.res;
    const all = await loadAll(a.agent, q.data.limit);
    return json(c, {
      agent: agentHeader(a.agent),
      issues: all.map(({ row, stored }) => ({
        epoch: row.epoch,
        title: stored.report.title,
        intro: stored.report.intro,
        generatedAt: stored.report.generatedAt,
        regions: stored.report.regions.map((r) => ({ region: r.region, summary: r.summary, newsletter: r.newsletter, events: r.events })),
      })),
    });
  });

  app.get(`${X402_PREFIX}/catalog/export`, (c) => {
    const q = ExportQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_query");
    const cat = deps.catalog?.catalog();
    if (!cat) return fail(c, 503, "catalog_unavailable");
    let categoryMask: bigint | null = null;
    let regionMask: number | null = null;
    try {
      if (q.data.category) categoryMask = categoryMaskOf(q.data.category.split(","));
      if (q.data.region) regionMask = regionMaskOf(q.data.region.split(","));
    } catch {
      return fail(c, 400, "invalid_query");
    }
    const matched = cat.orgs.filter(
      (o) =>
        (categoryMask === null || (BigInt(o.categoryMask) & categoryMask) !== 0n) &&
        (regionMask === null || (o.regionMask & regionMask) !== 0),
    );
    const { offset, limit } = q.data;
    return json(c, {
      root: cat.meta.root,
      taxonomyVersion: cat.meta.taxonomyVersion,
      builtAt: cat.meta.builtAt,
      sourceAsOf: cat.meta.sourceAsOf,
      total: matched.length,
      offset,
      limit,
      items: matched.slice(offset, offset + limit),
    });
  });
}
