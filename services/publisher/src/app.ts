import { bzzUri, swarmGatewayUrl } from "@verada/sdk";
import { mountAgentReports, type CuratorChain } from "./agents.js";
import { mountFacilitator, type FacilitatorDeps } from "./facilitator.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PublisherConfig } from "./env.js";
import { canonicalJson, TokenMetadata } from "./metadata.js";
import { corsMiddleware, methodGate, RateLimiter, rateLimitMiddleware } from "./security.js";
import { sniffImage } from "./sniff.js";
import { SwarmError, type SwarmClient } from "./swarm.js";

export interface AppDeps {
  config: PublisherConfig;
  /** Absent when the gateway or batch id is not configured; uploads then answer 503. */
  swarm?: SwarmClient;
  limiter?: RateLimiter;
  /** Curator signers on chain; `POST /agents/reports` answers 503 without it. */
  curators?: CuratorChain;
  /** Mainnet x402 facilitator; `/x402/*` is absent without it. */
  facilitator?: Omit<FacilitatorDeps, "log">;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

/** Room for multipart boundaries and part headers on top of the file itself. */
const MULTIPART_OVERHEAD = 16 * 1024;

const NO_STORE = "no-store";

const tooLarge = (c: Context) => {
  c.header("Cache-Control", NO_STORE);
  return c.json({ error: "payload_too_large" }, 413);
};

/**
 * Builds the publisher API. Requests are never logged with bodies, file names, IPs or addresses
 * (PRIVACY.md); the only address that reaches Swarm is the optional `launcher` in metadata.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, swarm } = deps;
  const log =
    deps.log ??
    ((level, msg, data) => {
      const line = JSON.stringify({ level, msg, ...data });
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    });
  const limiter = deps.limiter ?? new RateLimiter(config.rateRps, config.rateBurst);
  const publicGateway = config.swarm.publicGatewayUrl;

  const app = new Hono();
  app.use("*", corsMiddleware(config.corsOrigins));
  app.use("*", methodGate());
  app.use("/uploads/*", rateLimitMiddleware(limiter, config.trustProxyHops, config.rateBurst));
  app.use("/site", rateLimitMiddleware(limiter, config.trustProxyHops, config.rateBurst));
  app.use("/agents/*", rateLimitMiddleware(limiter, config.trustProxyHops, config.rateBurst));

  app.onError((err, c) => {
    c.header("Cache-Control", NO_STORE);
    log("error", "request failed", { error: err instanceof Error ? err.name : "unknown" });
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => {
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "not_found" }, 404);
  });

  app.get("/health", (c) => {
    c.header("Cache-Control", NO_STORE);
    return c.json({ status: "ok", uploads: Boolean(swarm && publicGateway) });
  });

  const uploadsReady = (c: Context) => {
    if (swarm && publicGateway) return null;
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "uploads_unavailable" }, 503);
  };

  const upstreamFailed = (c: Context, err: unknown) => {
    log("warn", "swarm upload failed", {
      error: err instanceof SwarmError ? err.message : "unknown",
      status: err instanceof SwarmError ? err.status : undefined,
    });
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "upstream_unavailable" }, 502);
  };

  app.post(
    "/uploads/logo",
    bodyLimit({ maxSize: config.maxLogoBytes + MULTIPART_OVERHEAD, onError: tooLarge }),
    async (c) => {
      const unavailable = uploadsReady(c);
      if (unavailable) return unavailable;
      c.header("Cache-Control", NO_STORE);
      if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
        return c.json({ error: "unsupported_media_type", message: "send multipart/form-data with a file field" }, 415);
      }
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return c.json({ error: "invalid_request", message: "malformed multipart body" }, 400);
      }
      const file = form.file;
      if (!(file instanceof File)) return c.json({ error: "invalid_request", message: "missing file field" }, 400);
      if (file.size === 0) return c.json({ error: "invalid_request", message: "empty file" }, 400);
      if (file.size > config.maxLogoBytes) return tooLarge(c);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = sniffImage(bytes);
      if (!type) {
        return c.json({ error: "unsupported_media_type", message: "logo must be PNG, JPEG or WebP" }, 415);
      }
      let reference: string;
      try {
        reference = await swarm!.upload(bytes, { contentType: type.mime, name: `logo.${type.ext}` });
      } catch (err) {
        return upstreamFailed(c, err);
      }
      log("info", "logo uploaded", { reference, type: type.ext, bytes: bytes.length });
      return c.json({ reference, bzz: bzzUri(reference), url: swarmGatewayUrl(publicGateway!, reference) }, 201);
    },
  );

  app.post(
    "/uploads/metadata",
    bodyLimit({ maxSize: config.maxMetadataBytes, onError: tooLarge }),
    async (c) => {
      const unavailable = uploadsReady(c);
      if (unavailable) return unavailable;
      c.header("Cache-Control", NO_STORE);
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
        return c.json({ error: "unsupported_media_type", message: "send application/json" }, 415);
      }
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: "invalid_request", message: "malformed JSON" }, 400);
      }
      const parsed = TokenMetadata.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "invalid_request",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          400,
        );
      }
      const json = canonicalJson(parsed.data);
      let reference: string;
      try {
        reference = await swarm!.upload(new TextEncoder().encode(json), {
          contentType: "application/json",
          name: "metadata.json",
        });
      } catch (err) {
        return upstreamFailed(c, err);
      }
      log("info", "metadata uploaded", { reference, bytes: json.length });
      return c.json({ reference, uri: bzzUri(reference), url: swarmGatewayUrl(publicGateway!, reference) }, 201);
    },
  );

  app.get("/site", async (c) => {
    c.header("Cache-Control", "public, max-age=30");
    const out: Record<string, unknown> = {
      gateway: publicGateway ?? null,
      batchId: config.swarm.batchId ?? null,
      stamp: null,
    };
    if (config.siteFeed.owner) out.feedOwner = config.siteFeed.owner;
    if (config.siteFeed.manifest) out.feedManifest = config.siteFeed.manifest;
    if (swarm) {
      try {
        const s = await swarm.stamp();
        out.stamp = {
          usable: s.usable,
          batchTTL: s.batchTTL,
          ttlDays: s.batchTTL >= 0 ? Math.floor(s.batchTTL / 86_400) : null,
          utilization: s.utilization,
          utilizationRatio: Number(s.utilizationRatio.toFixed(4)),
          depth: s.depth,
          bucketDepth: s.bucketDepth,
          amount: s.amount,
          immutable: s.immutableFlag,
        };
      } catch (err) {
        out.stampError = err instanceof SwarmError ? "unavailable" : "error";
      }
    }
    return c.json(out);
  });

  mountAgentReports(app, {
    swarm,
    publicGatewayUrl: publicGateway,
    chain: deps.curators,
    maxReportBytes: config.maxReportBytes,
    log,
  });
  if (deps.facilitator) mountFacilitator(app, { ...deps.facilitator, log });

  return app;
}
