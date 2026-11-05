import { normalizeSwarmReference } from "@verada/sdk";
import { z } from "zod";

export interface StampStatus {
  batchID: string;
  utilization: number;
  usable: boolean;
  depth: number;
  amount: string;
  bucketDepth: number;
  /** Seconds until the batch expires (Bee reports -1 when unknown). */
  batchTTL: number;
  immutableFlag: boolean;
  /** Fullest bucket's fill: `utilization / 2^(depth - bucketDepth)`. */
  utilizationRatio: number;
}

const StampResponse = z.object({
  batchID: z.string(),
  utilization: z.number(),
  usable: z.boolean(),
  depth: z.number().int(),
  amount: z.union([z.string(), z.number()]).transform(String),
  bucketDepth: z.number().int(),
  batchTTL: z.number(),
  immutableFlag: z.boolean(),
});

export class SwarmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SwarmError";
  }
}

export interface SwarmClient {
  /** Uploads one file through the gateway (`POST /bzz?name=`), pinned, not deferred. */
  upload(body: Uint8Array, opts: { contentType: string; name: string }): Promise<string>;
  /** Postage batch status (`GET /stamps/{batchId}`). */
  stamp(): Promise<StampStatus>;
}

export interface SwarmClientOptions {
  gatewayUrl: string;
  batchId: string;
  /** Sent verbatim as `Authorization` (swarm-gateway compares it to AUTH_SECRET as is). */
  authSecret?: string;
  /** Base URL serving `/stamps/{id}`; defaults to `gatewayUrl`. */
  stampsUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Plain-fetch client for the Bee HTTP API shape the swarm-gateway exposes. */
export function createSwarmClient(opts: SwarmClientOptions): SwarmClient {
  const f = opts.fetch ?? fetch;
  const base = opts.gatewayUrl.replace(/\/+$/, "");
  const stampsBase = (opts.stampsUrl ?? opts.gatewayUrl).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const auth: Record<string, string> = opts.authSecret ? { Authorization: opts.authSecret } : {};

  return {
    async upload(body, { contentType, name }) {
      let res: Response;
      try {
        res = await f(`${base}/bzz?name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": contentType,
            "swarm-postage-batch-id": opts.batchId,
            "swarm-pin": "true",
            "swarm-deferred-upload": "false",
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new SwarmError("gateway unreachable");
      }
      if (!res.ok) throw new SwarmError(`gateway upload failed with HTTP ${res.status}`, res.status);
      const json = (await res.json().catch(() => null)) as { reference?: unknown } | null;
      if (!json || typeof json.reference !== "string") throw new SwarmError("gateway returned no reference");
      try {
        return normalizeSwarmReference(json.reference);
      } catch {
        throw new SwarmError("gateway returned an invalid reference");
      }
    },

    async stamp() {
      let res: Response;
      try {
        res = await f(`${stampsBase}/stamps/${opts.batchId}`, {
          headers: { ...auth, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new SwarmError("stamps endpoint unreachable");
      }
      if (!res.ok) throw new SwarmError(`stamp lookup failed with HTTP ${res.status}`, res.status);
      const parsed = StampResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new SwarmError("unexpected stamp response");
      const s = parsed.data;
      const buckets = 2 ** Math.max(0, s.depth - s.bucketDepth);
      return { ...s, utilizationRatio: buckets > 0 ? s.utilization / buckets : 0 };
    },
  };
}
