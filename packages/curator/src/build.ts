import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { BuiltCatalog } from "@verada/cause-catalog";
import { PICK_LEAF_TYPES, agentBySlug, bucketId, regionBySlug } from "@verada/sdk";
import { keccak256, toHex, type Hex } from "viem";
import type { Report } from "./report.js";

export type PickLeaf = [number, number, Hex];

export interface BuiltRegion {
  region: string;
  regionBit: number;
  bucket: number;
  weight: number;
  count: number;
  /** Zero when the region has no picks. */
  picksRoot: Hex;
  /** OpenZeppelin `StandardMerkleTree` dump, for serving pick proofs. */
  tree: unknown | null;
}

export interface BuiltReport {
  report: Report;
  /** keccak256 of the canonical report JSON (what the publisher signature covers). */
  reportHash: Hex;
  categoryBit: number;
  regions: BuiltRegion[];
}

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** Canonical JSON (sorted keys) so the hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Checks every pick against the catalogue (the entry at `catalogIndex` of the region's bucket must be
 * that org) and builds each region's picks tree. The contracts would skip a wrong pick anyway; this
 * refuses to publish one.
 */
export function buildReport(report: Report, catalog: BuiltCatalog | null): BuiltReport {
  const agent = agentBySlug(report.category);
  if (!agent) throw new ReportError(`no agent for ${report.category}`);
  const orgAt = new Map<string, Hex>();
  if (catalog) for (const [, [b, i, o]] of catalog.tree.entries()) orgAt.set(`${b}:${i}`, o.toLowerCase() as Hex);

  const regions: BuiltRegion[] = report.regions.map((r) => {
    const regionBit = regionBySlug(r.region).bit;
    const bucket = bucketId(agent.bit, regionBit);
    if (catalog) {
      r.picks.forEach((p, rank) => {
        const actual = orgAt.get(`${bucket}:${p.catalogIndex}`);
        if (actual !== p.orgId) {
          throw new ReportError(`${r.region} pick ${rank} (${p.name}): entry ${p.catalogIndex} of bucket ${bucket} is ${actual ?? "missing"}, not ${p.orgId}`);
        }
      });
    }
    if (r.picks.length === 0) {
      return { region: r.region, regionBit, bucket, weight: 0, count: 0, picksRoot: `0x${"0".repeat(64)}` as Hex, tree: null };
    }
    const leaves: PickLeaf[] = r.picks.map((p, rank) => [rank, p.catalogIndex, p.orgId]);
    const tree = StandardMerkleTree.of(leaves, [...PICK_LEAF_TYPES]);
    return { region: r.region, regionBit, bucket, weight: r.weight, count: r.picks.length, picksRoot: tree.root as Hex, tree: tree.dump() };
  });
  return { report, reportHash: keccak256(toHex(canonicalJson(report))), categoryBit: agent.bit, regions };
}

/** Proof of pick `rank` from a built region's tree dump. */
export function pickProof(region: BuiltRegion, rank: number, catalogIndex: number, orgId: Hex): Hex[] {
  if (!region.tree) throw new ReportError(`${region.region} has no picks`);
  const tree = StandardMerkleTree.load<PickLeaf>(region.tree as never);
  return tree.getProof([rank, catalogIndex, orgId]) as Hex[];
}
