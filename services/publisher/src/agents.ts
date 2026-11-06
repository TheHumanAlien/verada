import { buildReport, canonicalJson, ReportSchema } from "@verada/curator";
import { swarmGatewayUrl } from "@verada/sdk";
import { curatorRegistryAbi } from "@verada/sdk/abis";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createPublicClient, fallback, http, isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { SwarmError, type SwarmClient } from "./swarm.js";

/** The on-chain facts the publisher needs to authenticate a curator: its current signer. */
export interface CuratorChain {
  /** The agent's signer and whether it is active, or null when no agent is registered. */
  agentOf(categoryBit: number): Promise<{ signer: Address; active: boolean } | null>;
}

export function viemCuratorChain(rpcUrls: string[], registry: Address): CuratorChain {
  const client = createPublicClient({ chain: mainnet, transport: fallback(rpcUrls.map((u) => http(u))) });
  return {
    async agentOf(categoryBit) {
      const registered = await client.readContract({ address: registry, abi: curatorRegistryAbi, functionName: "isRegistered", args: [categoryBit] });
      if (!registered) return null;
      const a = await client.readContract({ address: registry, abi: curatorRegistryAbi, functionName: "agentOf", args: [categoryBit] });
      return { signer: a.signer, active: a.active };
    },
  };
}

export interface AgentReportDeps {
  swarm?: SwarmClient;
  publicGatewayUrl?: string;
  chain?: CuratorChain;
  maxReportBytes: number;
  log: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Accepts a signer's EIP-191 signature over the report hash, whether the signer hashed the
 * 32 bytes (viem `{ raw }`) or the 66-character hex string (some HSM APIs sign the text).
 */
export async function recoverReportSigner(hash: Hex, signature: Hex): Promise<Address[]> {
  const out: Address[] = [];
  for (const message of [{ raw: hash }, hash] as const) {
    try {
      out.push(await recoverMessageAddress({ message, signature }));
    } catch {
      // malformed signature for this encoding
    }
  }
  return out;
}

/**
 * `POST /agents/reports`: a curator agent's weekly report, uploaded to Swarm.
 *
 * The publisher re-derives the pick trees from the report itself (it never trusts uploaded trees),
 * hashes the canonical report, and requires `x-curator-signature` to recover to the category's
 * active signer in `CuratorRegistry`. Only then is `{ report, regions }` uploaded; the returned
 * reference is what the agent passes to `submitCurations` as `reportRef`.
 */
export function mountAgentReports(app: Hono, deps: AgentReportDeps): void {
  const json = (c: Context, body: unknown, status: 201 | 400 | 401 | 403 | 413 | 415 | 502 | 503) => {
    c.header("Cache-Control", "no-store");
    return c.json(body as object, status);
  };

  app.post(
    "/agents/reports",
    bodyLimit({ maxSize: deps.maxReportBytes, onError: (c) => json(c, { error: "payload_too_large" }, 413) }),
    async (c) => {
      if (!deps.swarm || !deps.publicGatewayUrl || !deps.chain) return json(c, { error: "reports_unavailable" }, 503);
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
        return json(c, { error: "unsupported_media_type", message: "send application/json" }, 415);
      }
      const signature = c.req.header("x-curator-signature") ?? "";
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return json(c, { error: "missing_signature" }, 401);
      let body: { report?: unknown };
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return json(c, { error: "invalid_request", message: "malformed JSON" }, 400);
      }
      const parsed = ReportSchema.safeParse(body?.report);
      if (!parsed.success) {
        return json(c, { error: "invalid_request", issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
      }
      let built: ReturnType<typeof buildReport>;
      try {
        // Catalogue membership is enforced on chain at ballot time; here only the shape and trees.
        built = buildReport(parsed.data, null);
      } catch (err) {
        return json(c, { error: "invalid_request", message: err instanceof Error ? err.message : "invalid report" }, 400);
      }
      const agent = await deps.chain.agentOf(built.categoryBit);
      if (!agent) return json(c, { error: "unknown_agent" }, 403);
      if (!agent.active) return json(c, { error: "agent_inactive" }, 403);
      const signers = await recoverReportSigner(built.reportHash, signature as Hex);
      if (!signers.some((s) => isAddressEqual(s, agent.signer))) return json(c, { error: "bad_signature" }, 401);

      const payload = canonicalJson({ report: built.report, regions: built.regions });
      let reference: string;
      try {
        reference = await deps.swarm.upload(new TextEncoder().encode(payload), {
          contentType: "application/json",
          name: `${parsed.data.category}-${parsed.data.epoch}.json`,
        });
      } catch (err) {
        deps.log("warn", "swarm upload failed", { error: err instanceof SwarmError ? err.message : "unknown" });
        return json(c, { error: "upstream_unavailable" }, 502);
      }
      deps.log("info", "curator report uploaded", { category: parsed.data.category, epoch: parsed.data.epoch, reference, bytes: payload.length });
      return json(
        c,
        {
          reference,
          reportRef: `0x${reference}`,
          reportHash: built.reportHash,
          url: swarmGatewayUrl(deps.publicGatewayUrl, reference),
          regions: built.regions.map((r) => ({ region: r.region, picksRoot: r.picksRoot, count: r.count, weight: r.weight })),
        },
        201,
      );
    },
  );
}
