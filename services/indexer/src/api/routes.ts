import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ActivityBus } from "./bus";
import type { ApiConfig } from "./config";
import { type Cursor, decodeCursor, decodeOffset, encodeCursor, encodeOffset } from "./cursor";
import type { CauseSearch } from "./search";
import {
  corsMiddleware,
  RateLimiter,
  rateLimitMiddleware,
  readOnlyGate,
} from "./security";
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  type Repo,
  activityCursor,
} from "./types";

export interface ApiDeps {
  repo: Repo;
  search: CauseSearch;
  config: ApiConfig;
  bus?: ActivityBus;
  limiter?: RateLimiter;
  now?: () => number;
}

const CACHE = {
  list: "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
  detail: "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
  stats: "public, max-age=0, s-maxage=15, stale-while-revalidate=30",
  causes: "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
  search: "public, max-age=30, s-maxage=300, stale-while-revalidate=600",
  none: "no-store",
} as const;

const serialize = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Sends JSON with Cache-Control and a weak ETag; honours If-None-Match. */
function send(c: Context, body: unknown, cache: string, status: 200 | 404 = 200) {
  const text = serialize(body);
  c.header("Cache-Control", cache);
  if (status === 200 && cache !== CACHE.none) {
    const etag = `W/"${createHash("sha1").update(text).digest("base64url").slice(0, 27)}"`;
    c.header("ETag", etag);
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").some((t) => t.trim() === etag)) return c.body(null, 304);
  }
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(text, status);
}

const bad = (c: Context, issues: { path: string; message: string }[]) => {
  c.header("Cache-Control", CACHE.none);
  return c.json({ error: "invalid_request", issues }, 400);
};

const blank = (v: unknown) => (v === "" ? undefined : v);
const limitSchema = z.preprocess(blank, z.coerce.number().int().min(1).max(100).default(25));
const cursorSchema = z.preprocess(blank, z.string().max(400).optional());
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

function parse<T extends z.ZodTypeAny>(c: Context, schema: T, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true as const, data: r.data as z.infer<T> };
  return {
    ok: false as const,
    res: bad(
      c,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    ),
  };
}

function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}

const ListQuery = z.object({ cursor: cursorSchema, limit: limitSchema });

const ActivityQuerySchema = ListQuery.extend({
  token: z.preprocess(blank, addressSchema.optional()),
  kind: z.preprocess(
    blank,
    z
      .string()
      .max(100)
      .optional()
      .transform((s, ctx) => {
        if (!s) return undefined;
        const kinds = [...new Set(s.split(",").map((k) => k.trim()).filter(Boolean))];
        const invalid = kinds.filter((k) => !(ACTIVITY_KINDS as readonly string[]).includes(k));
        if (invalid.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `unknown kind; expected one of ${ACTIVITY_KINDS.join(", ")}`,
          });
          return z.NEVER;
        }
        return kinds as ActivityKind[];
      }),
  ),
});

const SearchQuery = z.object({
  q: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(2, "at least 2 characters").max(100)),
  cursor: cursorSchema,
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(25).default(10)),
});

const EpochParam = z.string().regex(/^\d{1,18}$/, "must be a non-negative integer");

export function createApi(deps: ApiDeps): Hono {
  const { repo, search, config } = deps;
  const limiter = deps.limiter ?? new RateLimiter(config.rateRps, config.rateBurst);
  const bus =
    deps.bus ??
    new ActivityBus(() => repo.listActivity({ limit: 100 }), config.ssePollMs);
  let sseClients = 0;

  const app = new Hono();
  app.use("*", corsMiddleware(config.corsOrigins));
  app.use("*", rateLimitMiddleware(limiter, config.trustProxyHops, config.rateBurst));
  app.use("/api/*", readOnlyGate(config.maxUrlLength));

  app.onError((err, c) => {
    c.header("Cache-Control", CACHE.none);
    // Never echo internals; the detail stays in the server log.
    console.error("api error", err instanceof Error ? err.message : "unknown");
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => {
    c.header("Cache-Control", CACHE.none);
    return c.json({ error: "not_found" }, 404);
  });

  app.get("/api/health", (c) => send(c, { status: "ok" }, CACHE.none));

  app.get("/api/tokens", async (c) => {
    const p = parse(c, ListQuery, c.req.query());
    if (!p.ok) return p.res;
    let before: Cursor | undefined;
    if (p.data.cursor) {
      before = decodeCursor(p.data.cursor) ?? undefined;
      if (!before) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
    }
    const rows = await repo.listTokens({ before, limit: p.data.limit + 1 });
    const page = paginate(rows, p.data.limit, (t) =>
      encodeCursor({ t: t.createdAt.toString(), k: t.address }),
    );
    const totals = await repo.feeTotalsFor(page.items.map((t) => t.address));
    const byToken = new Map(totals.map((f) => [f.token, f]));
    return send(
      c,
      {
        items: page.items.map((t) => ({ ...t, feeTotals: byToken.get(t.address) ?? null })),
        nextCursor: page.nextCursor,
      },
      CACHE.list,
    );
  });

  app.get("/api/tokens/:address", async (c) => {
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    const found = await repo.getToken(a.data);
    if (!found) return send(c, { error: "not_found" }, CACHE.none, 404);
    return send(c, { ...found.token, feeTotals: found.feeTotals }, CACHE.detail);
  });

  app.get("/api/activity", async (c) => {
    const p = parse(c, ActivityQuerySchema, c.req.query());
    if (!p.ok) return p.res;
    let before: Cursor | undefined;
    if (p.data.cursor) {
      before = decodeCursor(p.data.cursor) ?? undefined;
      if (!before) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
    }
    const rows = await repo.listActivity({
      kinds: p.data.kind,
      token: p.data.token,
      before,
      limit: p.data.limit + 1,
    });
    const page = paginate(rows, p.data.limit, (i) => encodeCursor(activityCursor(i)));
    return send(c, page, CACHE.list);
  });

  app.get("/api/activity/stream", async (c) => {
    if (sseClients >= config.sseMaxClients) {
      c.header("Retry-After", "5");
      return c.json({ error: "too_many_streams" }, 503);
    }
    const lastId = c.req.header("last-event-id");
    let resume: Cursor | null = null;
    if (lastId) {
      resume = decodeCursor(lastId);
      if (!resume) return bad(c, [{ path: "Last-Event-ID", message: "invalid event id" }]);
    }
    const onlyToken = c.req.query("token");
    let tokenFilter: string | undefined;
    if (onlyToken) {
      const a = addressSchema.safeParse(onlyToken);
      if (!a.success) return bad(c, [{ path: "token", message: "must be a 20-byte hex address" }]);
      tokenFilter = a.data;
    }

    sseClients++;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let queue: import("./types").ActivityItem[] = [];
      let wake: (() => void) | null = null;
      const poke = () => {
        wake?.();
        wake = null;
      };
      const unsubscribe = bus.subscribe((items) => {
        queue.push(...items);
        poke();
      });
      stream.onAbort(poke);
      try {
        await stream.write("retry: 3000\n\n");
        if (resume) {
          const { items, gap } = await bus.since(resume);
          if (gap) await stream.writeSSE({ event: "reset", data: "{}" });
          queue = [...items, ...queue.filter((q) => !items.some((i) => i.id === q.id))];
        }
        const deadline = Date.now() + config.sseMaxAgeMs;
        while (!stream.aborted && !stream.closed && Date.now() < deadline) {
          const batch = queue;
          queue = [];
          for (const item of batch) {
            if (tokenFilter && item.token !== tokenFilter) continue;
            await stream.writeSSE({
              id: encodeCursor(activityCursor(item)),
              event: "activity",
              data: serialize(item),
            });
          }
          if (queue.length > 0) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
            const t = setTimeout(resolve, Math.min(config.sseHeartbeatMs, Math.max(1, deadline - Date.now())));
            t.unref?.();
          });
          if (queue.length === 0 && !stream.aborted) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe();
        sseClients--;
      }
    });
  });

  app.get("/api/causes", async (c) => {
    const rows = await repo.listCauses();
    return send(c, { items: rows, nextCursor: null }, CACHE.causes);
  });

  app.get("/api/causes/search", async (c) => {
    const p = parse(c, SearchQuery, c.req.query());
    if (!p.ok) return p.res;
    let offset = 0;
    if (p.data.cursor) {
      const o = decodeOffset(p.data.cursor);
      if (o === null) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
      offset = o;
    }
    let items;
    try {
      items = await search.search(p.data.q, offset, p.data.limit);
    } catch {
      c.header("Cache-Control", CACHE.none);
      return c.json({ error: "upstream_unavailable" }, 502);
    }
    const nextCursor = items.length === p.data.limit ? encodeOffset(offset + items.length) : null;
    return send(c, { items, nextCursor }, CACHE.search);
  });

  app.get("/api/epochs/:token", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const q = parse(c, ListQuery, c.req.query());
    if (!q.ok) return q.res;
    let before: bigint | undefined;
    if (q.data.cursor) {
      const d = decodeCursor(q.data.cursor);
      if (!d) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
      before = BigInt(d.t);
    }
    const rows = await repo.listEpochs(t.data, { before, limit: q.data.limit + 1 });
    const page = paginate(rows, q.data.limit, (e) => encodeCursor({ t: e.epoch.toString(), k: "e" }));
    return send(c, page, CACHE.list);
  });

  app.get("/api/epochs/:token/:epoch", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const e = parse(c, EpochParam, c.req.param("epoch"));
    if (!e.ok) return e.res;
    const found = await repo.getEpoch(t.data, BigInt(e.data));
    if (!found) return send(c, { error: "not_found" }, CACHE.none, 404);
    return send(c, { ...found.epoch, donations: found.donations }, CACHE.detail);
  });

  app.get("/api/stats", async (c) => {
    const s = await repo.stats();
    return send(c, { decimals: 6, currency: "USDC", ...s }, CACHE.stats);
  });

  return app;
}
