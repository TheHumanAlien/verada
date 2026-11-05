import { getAddress, type Address } from "viem";
import { z } from "zod";

/**
 * Shapes of the read-only indexer API rows the mirror consumes. Fields the indexer is still
 * gaining (label, controller, editor, logoRef, contenthash, name, symbol, textRecords) are
 * optional, so the mirror works before and after that change. Unknown keys are stripped.
 */

const blank = (v: unknown) => (v === "" || v === null ? undefined : v);

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((s) => getAddress(s.toLowerCase()) as Address);

const HexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex");

/** bigint columns arrive as decimal strings (the indexer serializes bigints as strings). */
export const BigIntSchema = z
  .union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative(), z.bigint()])
  .transform((v) => BigInt(v));

const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s.optional());

export const IndexerTokenSchema = z.object({
  address: AddressSchema,
  creator: AddressSchema,
  /** Uniswap v4 pool id (bytes32) or pool address; stored as a string. */
  pool: HexSchema.max(66),
  createdBlock: BigIntSchema,
  metadataUri: z.string().max(4096).default(""),
  label: optional(z.string().max(255)),
  controller: optional(AddressSchema),
  editor: optional(AddressSchema),
  logoRef: optional(z.string().max(130)),
  contenthash: optional(HexSchema.max(4096)),
  name: optional(z.string().max(1024)),
  symbol: optional(z.string().max(255)),
  /** ENS text records keyed by record key (`url`, `description`, `com.twitter`, ...). */
  textRecords: z.preprocess(blank, z.record(z.string(), z.string().nullable()).optional()),
  /** Cause focus (null until the indexer has seen `FocusSet`). */
  categoryMask: optional(BigIntSchema),
  regionMask: optional(z.number().int().min(0).max(0xffff)),
  /** Block of the last profile change, when the indexer exposes it. */
  updatedAtBlock: optional(BigIntSchema),
  updatedBlock: optional(BigIntSchema),
});
export type IndexerToken = z.infer<typeof IndexerTokenSchema>;

export const IndexerTokenPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable().optional(),
});

export const IndexerCauseSchema = z
  .object({
    causeId: HexSchema.max(66),
    payout: optional(AddressSchema),
    orgAddress: optional(AddressSchema),
    active: z.boolean(),
    orgId: optional(z.string().max(255)),
    ein: optional(z.string().max(64)),
    name: optional(z.string().max(1024)),
    nteeCode: optional(z.string().max(32)),
  })
  .refine((c) => c.orgAddress !== undefined || c.payout !== undefined, {
    message: "cause needs an orgAddress or payout",
  });
export type IndexerCause = z.infer<typeof IndexerCauseSchema>;

export const IndexerCausePageSchema = z.object({ items: z.array(z.unknown()) });

/**
 * Parses each item on its own so one malformed row does not stop the mirror; malformed rows are
 * returned separately for logging.
 */
export function parseItems<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  items: unknown[],
): { ok: T[]; rejected: number } {
  const ok: T[] = [];
  let rejected = 0;
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) ok.push(r.data);
    else rejected++;
  }
  return { ok, rejected };
}
