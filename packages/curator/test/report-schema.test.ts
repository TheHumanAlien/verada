import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORT_SCHEMA_PATH, renderReportJsonSchema } from "../scripts/report-schema.js";
import { ReportSchema } from "../src/report.js";

type Json = Record<string, any>;
const schema = JSON.parse(readFileSync(REPORT_SCHEMA_PATH, "utf8")) as Json;

/**
 * Just enough of a JSON Schema 2020-12 validator for the keywords the generator emits; it throws on
 * any other keyword so the test cannot pass by ignoring one.
 */
const KNOWN = new Set([
  "$schema", "$comment", "$defs", "$ref", "title", "description", "type", "const", "enum", "properties", "required",
  "additionalProperties", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "items", "minItems", "maxItems", "allOf", "contains", "minContains", "maxContains", "if", "then",
]);
function valid(s: Json, v: unknown, root: Json = s): boolean {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`validator does not support ${k}`);
  if (s.$ref) return valid(root.$defs[(s.$ref as string).replace("#/$defs/", "")], v, root);
  if ("const" in s && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  switch (s.type) {
    case undefined:
      break;
    case "object":
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      break;
    case "array":
      if (!Array.isArray(v)) return false;
      break;
    case "integer":
      if (!Number.isInteger(v)) return false;
      break;
    case "number":
      if (typeof v !== "number") return false;
      break;
    case "string":
      if (typeof v !== "string") return false;
      break;
    default:
      throw new Error(`type ${s.type}`);
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) return false;
    if (s.maxLength !== undefined && v.length > s.maxLength) return false;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return false;
    if (s.format === "uri" && !URL.canParse(v)) return false;
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return false;
    if (s.maximum !== undefined && v > s.maximum) return false;
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) return false;
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) return false;
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return false;
    if (s.maxItems !== undefined && v.length > s.maxItems) return false;
    if (s.items && !v.every((x) => valid(s.items, x, root))) return false;
    if (s.contains) {
      const n = v.filter((x) => valid(s.contains, x, root)).length;
      if (n < (s.minContains ?? 1) || (s.maxContains !== undefined && n > s.maxContains)) return false;
    }
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Json;
    if (s.required && !s.required.every((k: string) => k in o)) return false;
    for (const [k, sub] of Object.entries((s.properties ?? {}) as Json)) if (k in o && !valid(sub, o[k], root)) return false;
    if (s.additionalProperties === false && Object.keys(o).some((k) => !(k in (s.properties ?? {})))) return false;
  }
  if (s.allOf && !s.allOf.every((x: Json) => valid(x, v, root))) return false;
  if (s.if && valid(s.if, v, root) && s.then && !valid(s.then, v, root)) return false;
  return true;
}

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const pick = (i: number) => ({ orgId: hex(i + 1), catalogIndex: i, name: `Org ${i}`, score: 80, reasons: "Drought relief", sources: ["https://news.example/a"] });
const good = () => ({
  schema: "verada.curation/v1",
  category: "hunger",
  epoch: 12,
  catalogVersion: 1,
  generatedAt: "2026-11-09T08:00:00.000Z",
  title: "Hunger: week 12",
  intro: "",
  regions: [
    {
      region: "africa",
      weight: 7000,
      summary: "Drought in the Horn",
      events: [{ title: "Drought", url: "https://news.example/a", date: "2026-11-05", summary: "" }],
      picks: [pick(0), pick(1)],
      newsletter: "...",
    },
    { region: "asia", weight: 0, summary: "", events: [], picks: [], newsletter: "" },
  ],
});
type Sample = ReturnType<typeof good> & Json;
const edit = (f: (r: Sample) => void) => {
  const r = good() as Sample;
  f(r);
  return r;
};
const af = (r: Sample) => r.regions[0] as Json;

const SAMPLES: Record<string, unknown> = {
  good: good(),
  "unknown keys": edit((r) => ((r as Json).extra = 1, (af(r).note = "x"))),
  "uppercase orgId": edit((r) => (af(r).picks[0].orgId = hex(0xabc).toUpperCase().replace("0X", "0x"))),
  "32 picks": edit((r) => (af(r).picks = Array.from({ length: 32 }, (_, i) => pick(i)))),
  "8 regions": edit((r) => (r.regions = ["africa", "asia", "europe", "middle-east", "north-america", "latin-america", "oceania", "global"].map((region) => ({ region, weight: 0, summary: "", events: [], picks: [], newsletter: "" })))),
  "no seconds in generatedAt": edit((r) => (r.generatedAt = "2026-11-09T08:00Z")),
  "wrong schema": edit((r) => (r.schema = "verada.curation/v2")),
  "category without agent": edit((r) => (r.category = "other")),
  "unknown category": edit((r) => (r.category = "space")),
  "negative epoch": edit((r) => (r.epoch = -1)),
  "fractional epoch": edit((r) => (r.epoch = 1.5)),
  "catalogue version 0": edit((r) => (r.catalogVersion = 0)),
  "date-only generatedAt": edit((r) => (r.generatedAt = "2026-11-09")),
  "offset generatedAt": edit((r) => (r.generatedAt = "2026-11-09T08:00:00+01:00")),
  "empty title": edit((r) => (r.title = "")),
  "long title": edit((r) => (r.title = "x".repeat(301))),
  "missing intro": edit((r) => delete (r as Json).intro),
  "no regions": edit((r) => (r.regions = [])),
  "duplicate region": edit((r) => (r.regions = [r.regions[0]!, r.regions[0]!])),
  "unknown region": edit((r) => (af(r).region = "antarctica")),
  "weight above max": edit((r) => (af(r).weight = 10_001)),
  "negative weight": edit((r) => (af(r).weight = -1)),
  "weight without picks": edit((r) => ((r.regions[1] as Json).weight = 5)),
  "51 events": edit((r) => (af(r).events = Array.from({ length: 51 }, () => af(r).events[0]))),
  "ftp event url": edit((r) => (af(r).events[0].url = "ftp://news.example/a")),
  "relative event url": edit((r) => (af(r).events[0].url = "/a")),
  "event without title": edit((r) => delete af(r).events[0].title),
  "event date in words": edit((r) => (af(r).events[0].date = "Nov 5")),
  "short orgId": edit((r) => (af(r).picks[0].orgId = "0x1234")),
  "negative catalogIndex": edit((r) => (af(r).picks[0].catalogIndex = -1)),
  "score above 100": edit((r) => (af(r).picks[0].score = 101)),
  "empty reasons": edit((r) => (af(r).picks[0].reasons = "")),
  "11 sources": edit((r) => (af(r).picks[0].sources = Array.from({ length: 11 }, () => "https://news.example/a"))),
  "pick without name": edit((r) => delete af(r).picks[0].name),
  "33 picks": edit((r) => (af(r).picks = Array.from({ length: 33 }, (_, i) => pick(i)))),
  "string weight": edit((r) => (af(r).weight = "7000")),
};

describe("agents/report.schema.json", () => {
  it("is what the generator produces from ReportSchema (run `pnpm --filter @verada/curator schema:report`)", () => {
    expect(readFileSync(REPORT_SCHEMA_PATH, "utf8")).toBe(renderReportJsonSchema());
  });

  it("accepts and rejects the same reports as ReportSchema", () => {
    const verdicts = Object.entries(SAMPLES).map(([name, r]) => ({ name, zod: ReportSchema.safeParse(r).success, json: valid(schema, r) }));
    expect(verdicts.filter((v) => v.zod !== v.json)).toEqual([]);
    // The samples cover both outcomes.
    expect(verdicts.filter((v) => v.zod).length).toBeGreaterThanOrEqual(5);
    expect(verdicts.filter((v) => !v.zod).length).toBeGreaterThanOrEqual(25);
  });

  it("documents its one gap: duplicate picks pass the JSON Schema and fail ReportSchema", () => {
    const dup = edit((r) => (af(r).picks = [pick(0), { ...pick(0), orgId: pick(0).orgId.toUpperCase().replace("0X", "0x") }]));
    expect(valid(schema, dup)).toBe(true);
    expect(ReportSchema.safeParse(dup).success).toBe(false);
    expect(JSON.stringify(schema.$defs.RegionReport.properties.picks.$comment)).toMatch(/unique/);
  });
});
