import { type BZZ, Duration, Size, Utils } from "@ethersphere/bee-js";

const { getAmountForDuration, getDepthForSize, getStampCost, getStampEffectiveBytes } = Utils;
import type { FileEntry } from "./validate.js";

const CHUNK = 4096;
const BRANCHES = 128;

/** Rough chunk count: data chunks + intermediate chunks per file + manifest nodes. Estimate only. */
export function estimateChunks(files: FileEntry[]): number {
  let chunks = 0;
  for (const f of files) {
    let level = Math.max(1, Math.ceil(f.bytes / CHUNK));
    chunks += level;
    while (level > 1) {
      level = Math.ceil(level / BRANCHES);
      chunks += level;
    }
    chunks += 1; // per-file metadata chunk
  }
  return chunks + Math.ceil(files.length / 8) + 1; // manifest nodes
}

export interface StampEstimate {
  chunks: number;
  uploadBytes: number;
  depth: number;
  effectiveBytes: number;
  amountPlur: bigint;
  costBzz: string;
  ttlDays: number;
}

export interface StampParams {
  ttlDays: number;
  pricePerBlock: number; // PLUR per chunk per block
  blockTime: number; // seconds
  safetyFactor?: number;
}

export function estimateStamp(files: FileEntry[], p: StampParams): StampEstimate {
  const chunks = estimateChunks(files);
  const uploadBytes = chunks * CHUNK;
  // Stamp buckets fill unevenly, so size against effective capacity with headroom.
  const wanted = Math.ceil(uploadBytes * (p.safetyFactor ?? 2));
  const depth = Math.max(17, getDepthForSize(Size.fromBytes(wanted)));
  const amount = getAmountForDuration(Duration.fromDays(p.ttlDays), p.pricePerBlock, p.blockTime);
  const cost: BZZ = getStampCost(depth, amount);
  return {
    chunks,
    uploadBytes,
    depth,
    effectiveBytes: getStampEffectiveBytes(depth),
    amountPlur: amount,
    costBzz: cost.toDecimalString(),
    ttlDays: p.ttlDays,
  };
}
