import type { Context, MiddlewareHandler } from "hono";

/** Returns the Access-Control-Allow-Origin value for a request origin, or null if not allowed. */
export function matchOrigin(allow: string[], origin: string | undefined): string | null {
  if (allow.length === 0 || allow.includes("*")) return "*";
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const entry of allow) {
    if (entry === origin) return origin;
    // Wildcard-suffix pattern, optionally scheme-qualified: "*.bzz.link", "https://*.eth.limo".
    const m = /^(?:(https?):\/\/)?\*\.([a-z0-9.-]+)$/i.exec(entry);
    if (!m) continue;
    if (m[1] && `${m[1].toLowerCase()}:` !== url.protocol) continue;
    const suffix = `.${m[2]!.toLowerCase()}`;
    const host = url.hostname.toLowerCase();
    if (host.length > suffix.length && host.endsWith(suffix)) return origin;
  }
  return null;
}

export const EXPOSED_HEADERS =
  "ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, PAYMENT-REQUIRED, PAYMENT-RESPONSE";

/**
 * CORS for read-only routes. With no allowlist any origin may read (no credentials are ever used).
 * With an allowlist the origin is reflected only if it matches; others receive no CORS headers.
 */
export function corsMiddleware(allow: string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = matchOrigin(allow, origin);
    if (c.req.method === "OPTIONS") {
      if (origin && !allowed) return c.body(null, 403);
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match, Last-Event-ID, Accept, PAYMENT-SIGNATURE",
        "Access-Control-Max-Age": "600",
        Vary: "Origin, Access-Control-Request-Headers",
      };
      if (allowed) headers["Access-Control-Allow-Origin"] = allowed;
      return c.body(null, 204, headers);
    }
    await next();
    // Re-assert on the final response so an upstream wildcard cannot widen a restricted list.
    c.res.headers.delete("Access-Control-Allow-Origin");
    if (allowed) {
      c.res.headers.set("Access-Control-Allow-Origin", allowed);
      c.res.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }
    if (allow.length > 0 && !allow.includes("*")) c.res.headers.append("Vary", "Origin");
  };
}

export interface Bucket {
  tokens: number;
  updated: number;
}

/** In-memory token bucket keyed by client IP. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): { ok: boolean; remaining: number; retryAfterSeconds: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.burst, updated: t };
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.updated) / 1000) * this.rps);
      b.updated = t;
    }
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 };
    }
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / this.rps)),
    };
  }

  /** Drops full (idle) buckets, then the oldest entries if still over capacity. */
  private sweep(t: number) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.updated) / 1000) * this.rps >= this.burst) this.buckets.delete(k);
    }
    while (this.buckets.size >= this.maxKeys) {
      const first = this.buckets.keys().next().value;
      if (first === undefined) break;
      this.buckets.delete(first);
    }
  }
}

/** Client IP from X-Forwarded-For, trusting `hops` proxies (the rightmost entries are theirs). */
export function clientIp(c: Context, hops: number): string {
  const xff = c.req.header("x-forwarded-for");
  if (hops > 0 && xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = parts[parts.length - hops];
    if (ip) return ip.slice(0, 64);
  }
  return "unknown";
}

export function rateLimitMiddleware(limiter: RateLimiter, hops: number, burst: number): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const r = limiter.take(clientIp(c, hops));
    c.header("X-RateLimit-Limit", String(burst));
    c.header("X-RateLimit-Remaining", String(r.remaining));
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfterSeconds));
      c.header("Cache-Control", "no-store");
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

/** Read-only surface: GET/HEAD/OPTIONS only, no bodies, bounded URL length. */
export function readOnlyGate(maxUrlLength: number): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      c.header("Allow", "GET, HEAD, OPTIONS");
      return c.json({ error: "method_not_allowed" }, 405);
    }
    if (c.req.url.length > maxUrlLength) return c.json({ error: "uri_too_long" }, 414);
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 0) return c.json({ error: "payload_not_allowed" }, 413);
    return next();
  };
}
