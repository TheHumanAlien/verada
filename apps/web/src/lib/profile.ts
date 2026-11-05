import { isSwarmReference, MAX_BALLOT_OPTIONS, swarmContenthash } from "@verada/sdk";
import { isHex, type Hex } from "viem";

/**
 * Contenthash override input: `bzz://<ref>` or a bare 64-hex Swarm reference becomes the EIP-1577
 * Swarm contenthash; any other `0x` hex is passed through as raw contenthash bytes; empty clears the
 * override (the default dApp contenthash applies again).
 */
export function parseContenthashInput(input: string): { ok: true; value: Hex } | { ok: false; error: string } {
  const v = input.trim();
  if (v === "") return { ok: true, value: "0x" };
  if (/^bzz:\/\//i.test(v) || (!v.startsWith("0x") && isSwarmReference(v))) {
    try {
      return { ok: true, value: swarmContenthash(v) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "invalid Swarm reference" };
    }
  }
  if (isHex(v) && v.length % 2 === 0) {
    if ((v.length - 2) / 2 > 512) return { ok: false, error: "Contenthash is too long" };
    return { ok: true, value: v.toLowerCase() as Hex };
  }
  return { ok: false, error: "Enter bzz://<reference>, a 64-hex Swarm reference or 0x-prefixed contenthash bytes" };
}

/** Adds a cause to a shortlist draft: distinct, at most MAX_BALLOT_OPTIONS (10). */
export function addToShortlist(list: readonly Hex[], causeId: Hex): Hex[] | string {
  if (!isHex(causeId) || causeId.length !== 66) return "Cause id must be 32 bytes";
  if (list.some((c) => c.toLowerCase() === causeId.toLowerCase())) return "Cause is already on the shortlist";
  if (list.length >= MAX_BALLOT_OPTIONS) return `A shortlist holds at most ${MAX_BALLOT_OPTIONS} causes`;
  return [...list, causeId];
}

/** Options a ballot index refers to: the frozen epoch options once opened, else the shortlist that will be frozen. */
export function ballotOptions(opts: { opened: boolean; epochOptions: readonly string[]; shortlist: readonly string[] | null; defaultShortlist: readonly string[] }): {
  options: string[];
  frozen: boolean;
} {
  if (opts.opened || opts.epochOptions.length > 0) return { options: [...opts.epochOptions], frozen: true };
  const source = opts.shortlist && opts.shortlist.length > 0 ? opts.shortlist : opts.defaultShortlist;
  return { options: [...source], frozen: false };
}
