import { addr, bool, bytes, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import type { Address } from "viem";

/** Version stamped on every `TokenCore` (`version` column). Bump on a breaking schema change. */
export const SCHEMA_VERSION = 2;

/**
 * Owner a core entity is handed to once written. Arkiv rejects the zero address as a new owner,
 * so the conventional dead address stands in: nobody holds its key, so nobody can delete the
 * entity or hand it on. Combined with the `readonly` creation flag the core can never change.
 */
export const BURN_OWNER: Address = "0x000000000000000000000000000000000000dEaD";

/**
 * Immutable launch facts of one token. Written once, `readonly` + `permissionlessExtension`,
 * then owned by {@link BURN_OWNER}. Anyone may extend its lifetime; nobody may edit it.
 */
export const TokenCore = defineSchema("verada.token", {
  token: addr().indexed(),
  chainId: u64().indexed(),
  poolId: str().indexed(),
  creator: addr().indexed(),
  launchBlock: u64(),
  label: str().indexed(),
  metadataUri: str(),
  logoRef: str(),
  /**
   * The token's cause focus (fixed at launch): category and region slugs, each list wrapped in
   * commas (`,hunger,children-youth,`) so one slug can be matched with a glob, or `*` when the
   * focus covers every category (or region). Empty when the indexer had no focus for the token.
   */
  causeCategory: str().indexed(),
  causeRegion: str().indexed(),
  categoryMask: u64(),
  regionMask: i32(),
  version: i32(),
});

/**
 * Mutable profile of one token (links, description, logo, site). Owned by the platform account,
 * which patches it as the on-chain records change. `core` points at the token's {@link TokenCore}.
 */
export const TokenProfile = defineSchema("verada.token-profile", {
  core: key().indexed(),
  token: addr().indexed(),
  chainId: u64().indexed(),
  controller: addr().indexed(),
  editor: addr(),
  website: str().optional(),
  twitter: str().optional(),
  telegram: str().optional(),
  discord: str().optional(),
  /** UTF-8 description bytes (str columns cap at 128 bytes). */
  description: bytes().optional(),
  logoRef: str().optional(),
  contenthash: str().optional(),
  updatedAtBlock: u64(),
});

/** One allowlisted cause, mirrored from the on-chain cause registry. Owned by the platform. */
export const Cause = defineSchema("verada.cause", {
  causeId: str().indexed(),
  orgId: str().indexed(),
  ein: str().optional(),
  orgAddress: addr().indexed(),
  name: str(),
  nteeCode: str().optional(),
  active: bool().indexed(),
});

export type TokenCoreSchema = typeof TokenCore;
export type TokenProfileSchema = typeof TokenProfile;
export type CauseSchema = typeof Cause;
