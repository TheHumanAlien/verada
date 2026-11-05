import type { Address, Hex } from "viem";

/** Decoded `TokenCore` values (plain JS, no Arkiv value tags). */
export interface CoreValues {
  token: Address;
  chainId: bigint;
  poolId: string;
  creator: Address;
  launchBlock: bigint;
  label: string;
  metadataUri: string;
  logoRef: string;
  causeCategory: string;
  causeRegion: string;
  categoryMask: bigint;
  regionMask: number;
  version: number;
}

/** Optional `TokenProfile` columns, which a patch may unset. */
export const PROFILE_OPTIONAL_FIELDS = [
  "website",
  "twitter",
  "telegram",
  "discord",
  "description",
  "logoRef",
  "contenthash",
] as const;
export type ProfileOptionalField = (typeof PROFILE_OPTIONAL_FIELDS)[number];

/** Decoded `TokenProfile` values. `description` is the UTF-8 text (stored as bytes). */
export interface ProfileValues {
  core: Hex;
  token: Address;
  chainId: bigint;
  controller: Address;
  editor: Address;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  description?: string;
  logoRef?: string;
  contenthash?: string;
  updatedAtBlock: bigint;
}

/** A profile before its core key is known (the core is created in the same batch). */
export type ProfileDraft = Omit<ProfileValues, "core">;

/** Optional `Cause` columns. */
export const CAUSE_OPTIONAL_FIELDS = ["ein", "nteeCode"] as const;
export type CauseOptionalField = (typeof CAUSE_OPTIONAL_FIELDS)[number];

/** Decoded `Cause` values. */
export interface CauseValues {
  causeId: string;
  orgId: string;
  ein?: string;
  orgAddress: Address;
  name: string;
  nteeCode?: string;
  active: boolean;
}

/** An entity read back from Arkiv: its system fields plus decoded values. */
export interface StoredEntity<V> {
  key: Hex;
  owner: Address;
  creator: Address;
  /** Block the entity expires at. */
  expiresAt: bigint;
  values: V;
}

export type StoredCore = StoredEntity<CoreValues>;
export type StoredProfile = StoredEntity<ProfileValues>;
export type StoredCause = StoredEntity<CauseValues>;

/** `set`/`unset` changes for a patch, in decoded form. */
export interface Diff<V, O extends string> {
  set: Partial<V>;
  unset: O[];
}

export type ProfileDiff = Diff<ProfileValues, ProfileOptionalField>;
export type CauseDiff = Diff<CauseValues, CauseOptionalField>;
