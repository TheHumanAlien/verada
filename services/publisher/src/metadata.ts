import { getAddress, type Address } from "viem";
import { z } from "zod";

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), trimmed(1, max).optional());

const httpUrl = z
  .string()
  .trim()
  .max(256)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

/** Social handle or URL: printable, no whitespace or angle brackets. */
const handle = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .max(max)
      .regex(/^[^\s<>"'`]+$/, "must not contain whitespace or quotes")
      .optional(),
  );

/**
 * Off-chain token metadata stored on Swarm as `metadata.json`. Unknown keys are rejected so the
 * document holds only what the launch form is meant to publish. `launcher` is the only address
 * it may carry, and only when the creator chooses to include it.
 */
export const TokenMetadata = z
  .object({
    name: trimmed(1, 64),
    symbol: trimmed(1, 16).regex(/^[\p{L}\p{N}$._-]+$/u, "letters, digits and $._- only"),
    description: optionalText(2000),
    logoRef: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-hex Swarm reference")
      .transform((s) => s.toLowerCase()),
    website: z.preprocess((v) => (v === "" ? undefined : v), httpUrl.optional()),
    twitter: handle(64),
    telegram: handle(64),
    discord: handle(256),
    launcher: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
        .transform((s) => getAddress(s.toLowerCase()) as Address)
        .optional(),
    ),
  })
  .strict();

export type TokenMetadata = z.infer<typeof TokenMetadata>;

/**
 * Canonical JSON: object keys sorted (UTF-16 order), no insignificant whitespace, `undefined`
 * members dropped. The same metadata always yields the same bytes, hence the same Swarm reference.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
