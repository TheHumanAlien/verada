import { CATEGORIES, MAX_PICKS, MAX_WEIGHT, REGIONS, agentBySlug } from "@verada/sdk";
import { z } from "zod";

/**
 * A curator agent's weekly report: per region, the week's events with sources, up to 32 ranked
 * picks with scores, reasons and sources, the region's urgency weight, and the newsletter. The
 * report is published to Swarm whole; `CuratorRegistry` stores only each region's picks root.
 */

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32-byte hex").transform((s) => s.toLowerCase() as `0x${string}`);
const url = z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), "must be http(s)");

export const EventSchema = z.object({
  title: z.string().min(1).max(300),
  url,
  /** ISO date of the event or article. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  summary: z.string().max(2000),
});

export const PickSchema = z.object({
  orgId: hex32,
  /** Index of the org's entry in this region's catalogue bucket. */
  catalogIndex: z.number().int().min(0),
  name: z.string().min(1).max(300),
  /** Importance of the org's work this week, 0-100 (see the curator skill's rubric). */
  score: z.number().int().min(0).max(100),
  reasons: z.string().min(1).max(2000),
  sources: z.array(url).max(10),
});

export const RegionReportSchema = z.object({
  region: z.enum(REGIONS.map((r) => r.slug) as [string, ...string[]]),
  /** Urgency of the cause in this region this week, 0-10000. */
  weight: z.number().int().min(0).max(MAX_WEIGHT),
  summary: z.string().max(4000),
  events: z.array(EventSchema).max(50),
  /** Ranked, most important first; rank = position. */
  picks: z.array(PickSchema).max(MAX_PICKS),
  newsletter: z.string().max(20_000),
});

export const ReportSchema = z
  .object({
    schema: z.literal("verada.curation/v1"),
    category: z.enum(CATEGORIES.map((c) => c.slug) as [string, ...string[]]).refine((c) => agentBySlug(c) !== null, "no agent for this category"),
    epoch: z.number().int().min(0),
    catalogVersion: z.number().int().min(1),
    generatedAt: z.string().datetime(),
    title: z.string().min(1).max(300),
    /** Newsletter introduction, markdown. */
    intro: z.string().max(20_000),
    regions: z.array(RegionReportSchema).min(1).max(REGIONS.length),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.regions.forEach((reg, i) => {
      if (seen.has(reg.region)) ctx.addIssue({ code: "custom", path: ["regions", i, "region"], message: "duplicate region" });
      seen.add(reg.region);
      const orgs = new Set<string>();
      reg.picks.forEach((p, j) => {
        if (orgs.has(p.orgId)) ctx.addIssue({ code: "custom", path: ["regions", i, "picks", j], message: "duplicate pick" });
        orgs.add(p.orgId);
      });
      if (reg.picks.length === 0 && reg.weight !== 0) {
        ctx.addIssue({ code: "custom", path: ["regions", i, "weight"], message: "a region without picks must have weight 0" });
      }
    });
  });

export type Report = z.infer<typeof ReportSchema>;
export type RegionReport = z.infer<typeof RegionReportSchema>;

export function parseReport(json: unknown): Report {
  return ReportSchema.parse(json);
}
