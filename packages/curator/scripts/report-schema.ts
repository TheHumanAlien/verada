/**
 * Generates `agents/report.schema.json` (JSON Schema draft 2020-12) from the zod `ReportSchema`, so
 * routines and other tools can validate a curator report without this package.
 *
 *   pnpm --filter @verada/curator schema:report         # write the file
 *   pnpm --filter @verada/curator schema:report:check   # exit 1 when the checked-in file is stale
 *
 * The walker translates only the zod constructs the report uses and throws on anything else. Zod
 * refinements are opaque functions, so each one must have an entry in `REFINEMENTS` saying how it
 * maps to JSON Schema; a refinement without an entry (or an entry without a refinement) throws, so
 * a change to `report.ts` cannot silently drift from the published schema.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGIONS, agentBySlug } from "@verada/sdk";
import { datetimeRegex, type ZodTypeAny } from "zod";
import { EventSchema, PickSchema, RegionReportSchema, ReportSchema } from "../src/report.js";

export const REPORT_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../agents/report.schema.json");

type Json = Record<string, unknown>;

/** Schemas emitted once under `$defs` and referenced by name. */
const DEFS = new Map<ZodTypeAny, string>([
  [EventSchema, "Event"],
  [PickSchema, "Pick"],
  [RegionReportSchema, "RegionReport"],
]);

/**
 * How each zod refinement is expressed, keyed by location (`<Def>` for the def itself,
 * `<Def>.<prop>`, `[]` for array items). `apply` receives the translated node and the whole document.
 */
const REFINEMENTS: Record<string, (node: Json, doc: Json) => void> = {
  "Event.url": (n) => void (n.pattern = "^https?://"),
  "Pick.sources[]": (n) => void (n.pattern = "^https?://"),
  // agentBySlug(c) !== null: only categories with a curator agent ("other" has none).
  "Report.category": (n) => void (n.enum = (n.enum as string[]).filter((s) => agentBySlug(s) !== null)),
  // superRefine: unique regions, unique picks per region, weight 0 for a region without picks.
  Report: (n, doc) => {
    const regions = (n.properties as Json).regions as Json;
    regions.allOf = REGIONS.map((r) => ({
      contains: { type: "object", properties: { region: { const: r.slug } }, required: ["region"] },
      minContains: 0,
      maxContains: 1,
    }));
    regions.$comment = "Each region at most once.";
    const region = (doc.$defs as Json).RegionReport as Json;
    region.if = { properties: { picks: { maxItems: 0 } }, required: ["picks"] };
    region.then = { properties: { weight: { const: 0 } } };
    const picks = (region.properties as Json).picks as Json;
    picks.$comment = "orgId must be unique within a region (case-insensitive); JSON Schema cannot express this, the CLI's build step enforces it.";
  },
};

/** Descriptions (from report.ts and the curator skill), keyed like `REFINEMENTS`. */
const DESCRIPTIONS: Record<string, string> = {
  Report: "A curator agent's weekly report for one cause: per region, the week's events, up to 32 ranked catalogue picks and an urgency weight, plus the newsletter. Published whole to Swarm; CuratorRegistry stores each region's picks root.",
  "Report.schema": "Report format identifier.",
  "Report.category": "Cause category slug of the agent (CATEGORIES in @verada/sdk; only categories with a curator agent).",
  "Report.epoch": "The epoch the curation is for: CuratorRegistry.currentEpoch() + 1 at submission.",
  "Report.catalogVersion": "CauseCatalog version the picks index into; must be the version in effect at the epoch's start.",
  "Report.generatedAt": "ISO 8601 UTC timestamp (Z) of report generation.",
  "Report.intro": "Newsletter introduction, markdown.",
  "Report.regions": "One entry per region the agent reports on.",
  RegionReport: "One region's curation.",
  "RegionReport.region": "Region slug (REGIONS in @verada/sdk).",
  "RegionReport.weight": "Urgency of the cause in this region this week, 0-10000. Must be 0 when there are no picks.",
  "RegionReport.summary": "Short summary of the week in this region.",
  "RegionReport.events": "This week's events with sources.",
  "RegionReport.picks": "Ranked catalogue picks, most important first; rank = position.",
  "RegionReport.newsletter": "The region's newsletter section, markdown.",
  Event: "A news event or article.",
  "Event.date": "ISO date (YYYY-MM-DD...) of the event or article.",
  Pick: "A catalogue org picked for the ballot.",
  "Pick.orgId": "The org's 32-byte catalogue id (from `verada-curator pool`).",
  "Pick.catalogIndex": "Index of the org's entry in this region's catalogue bucket (from `verada-curator pool`).",
  "Pick.score": "Importance of the org's work this week, 0-100 (see the curator skill's rubric).",
  "Pick.reasons": "Why this org, this week.",
  "Pick.sources": "Supporting links.",
};

const typeName = (s: ZodTypeAny): string => (s._def as { typeName: string }).typeName;

interface Ctx {
  doc: Json;
  usedRefinements: Set<string>;
  usedDescriptions: Set<string>;
}

function describe(node: Json, key: string, ctx: Ctx): Json {
  const d = DESCRIPTIONS[key];
  if (d !== undefined) {
    ctx.usedDescriptions.add(key);
    return { description: d, ...node };
  }
  return node;
}

function convert(s: ZodTypeAny, key: string, ctx: Ctx, root = false): Json {
  const def = DEFS.get(s);
  if (def && !root) {
    const defs = ctx.doc.$defs as Json;
    if (!(def in defs)) {
      defs[def] = {}; // reserve: keeps $defs in first-use order
      defs[def] = convert(s, def, ctx, true);
    }
    return describe({ $ref: `#/$defs/${def}` }, key, ctx);
  }
  const d = s._def as Record<string, any>;
  switch (typeName(s)) {
    case "ZodEffects": {
      const inner = convert(d.schema, key, ctx, root);
      if (d.effect.type === "transform") return inner; // output-only (e.g. lowercasing); input unchanged
      if (d.effect.type !== "refinement") throw new Error(`${key}: unsupported zod effect ${d.effect.type}`);
      const apply = REFINEMENTS[key];
      if (!apply) throw new Error(`${key}: zod refinement has no JSON Schema translation; add one to REFINEMENTS`);
      if (ctx.usedRefinements.has(key)) throw new Error(`${key}: more than one refinement; give REFINEMENTS[${key}] all of them`);
      ctx.usedRefinements.add(key);
      apply(inner, ctx.doc);
      return inner;
    }
    case "ZodObject": {
      const shape = d.shape() as Record<string, ZodTypeAny>;
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const optional = typeName(v) === "ZodOptional";
        properties[k] = convert(optional ? (v._def as { innerType: ZodTypeAny }).innerType : v, `${key}.${k}`, ctx);
        if (!optional) required.push(k);
      }
      const out: Json = { type: "object", properties, required };
      // zod's default ("strip") accepts unknown keys and drops them; the head comment says so.
      if (d.unknownKeys === "strict") out.additionalProperties = false;
      return describe(out, key, ctx);
    }
    case "ZodString": {
      const out: Json = { type: "string" };
      for (const c of d.checks as { kind: string; [k: string]: any }[]) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "url") out.format = "uri";
        else if (c.kind === "regex") {
          if (c.regex.flags) throw new Error(`${key}: regex flags are not supported`);
          if (out.pattern) throw new Error(`${key}: more than one pattern`);
          out.pattern = c.regex.source;
        } else if (c.kind === "datetime") {
          out.format = "date-time";
          out.pattern = datetimeRegex({ precision: c.precision, offset: c.offset, local: c.local }).source;
        } else throw new Error(`${key}: unsupported string check ${c.kind}`);
      }
      return describe(out, key, ctx);
    }
    case "ZodNumber": {
      const out: Json = { type: "number" };
      for (const c of d.checks as { kind: string; value?: number; inclusive?: boolean }[]) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
        else throw new Error(`${key}: unsupported number check ${c.kind}`);
      }
      return describe(out, key, ctx);
    }
    case "ZodArray": {
      if (d.exactLength) throw new Error(`${key}: exact array length is not supported`);
      const out: Json = { type: "array", items: convert(d.type, `${key}[]`, ctx) };
      if (d.minLength) out.minItems = d.minLength.value;
      if (d.maxLength) out.maxItems = d.maxLength.value;
      return describe(out, key, ctx);
    }
    case "ZodEnum":
      return describe({ type: "string", enum: [...(d.values as string[])] }, key, ctx);
    case "ZodLiteral":
      return describe({ const: d.value }, key, ctx);
    default:
      throw new Error(`${key}: unsupported zod type ${typeName(s)}`);
  }
}

/** The JSON Schema of `ReportSchema`. */
export function reportJsonSchema(): Json {
  const doc: Json = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Verada curator report (verada.curation/v1)",
    $comment: "Generated from packages/curator/src/report.ts by packages/curator/scripts/report-schema.ts; do not edit by hand. Unknown object keys are accepted and dropped by the parser, so they never reach the published report.",
    $defs: {},
  };
  const ctx: Ctx = { doc, usedRefinements: new Set(), usedDescriptions: new Set() };
  const body = convert(ReportSchema, "Report", ctx, true);
  const unusedRefinements = Object.keys(REFINEMENTS).filter((k) => !ctx.usedRefinements.has(k));
  if (unusedRefinements.length) throw new Error(`REFINEMENTS without a zod refinement: ${unusedRefinements.join(", ")}`);
  const unusedDescriptions = Object.keys(DESCRIPTIONS).filter((k) => !ctx.usedDescriptions.has(k));
  if (unusedDescriptions.length) throw new Error(`DESCRIPTIONS for unknown locations: ${unusedDescriptions.join(", ")}`);
  const { $defs, ...head } = doc;
  return { ...head, ...body, $defs };
}

export const renderReportJsonSchema = (): string => `${JSON.stringify(reportJsonSchema(), null, 2)}\n`;

async function main() {
  const want = renderReportJsonSchema();
  if (process.argv.includes("--check")) {
    const have = await readFile(REPORT_SCHEMA_PATH, "utf8").catch(() => "");
    if (have !== want) {
      process.stderr.write(`${REPORT_SCHEMA_PATH} is stale; run: pnpm --filter @verada/curator schema:report\n`);
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(REPORT_SCHEMA_PATH, want);
  process.stdout.write(`wrote ${REPORT_SCHEMA_PATH}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
