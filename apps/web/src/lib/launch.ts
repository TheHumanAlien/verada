import { getAddress, isAddress, isHex, toHex, type Address, type Hex } from "viem";
import {
  ALL_CATEGORIES_MASK,
  ALL_REGIONS_MASK,
  categoryMaskOf,
  EXTERNAL_ADDRESSES,
  isValidLabel,
  normalizeSwarmReference,
  regionMaskOf,
  swarmReferenceToBytes32,
} from "@verada/sdk";
import type { TokenMetadataDocument } from "./publisher";

// Fee bounds mirror the contract constants MIN_FEE_BPS / MAX_FEE_BPS.
export const MIN_FEE_BPS = 100;
export const MAX_FEE_BPS = 500;

export interface LaunchInput {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: string;
  baseFeeBps: string;
  sniperFeeStartBps: string;
  sniperDecaySeconds: string;
  startTick: string;
  /** Quote asset address; must be allowlisted in the on-chain quote registry. */
  quoteAsset: string;
  /** ENS label: the token's name becomes `<label>.<parent>`. */
  label: string;
  /** Swarm reference of the uploaded logo (64 hex, `0x` or `bzz://` optional); empty for none. */
  logoRef: string;
  /** Cause focus, fixed forever: category and region slugs (empty: any). */
  categories: string[];
  regions: string[];
}

export interface DeployParams {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: Hex;
  baseFeeBps: number;
  sniperFeeStartBps: number;
  sniperDecaySeconds: number;
  startTick: number;
  quoteAsset: Address;
  label: string;
  logoRef: Hex;
  categoryMask: bigint;
  regionMask: number;
}

export const ZERO_LOGO_REF: Hex = `0x${"0".repeat(64)}`;

export type ParseResult = { ok: true; params: DeployParams } | { ok: false; error: string };

function int(value: string, label: string, min: number, max: number): number | string {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n)) return `${label} must be an integer`;
  if (n < min || n > max) return `${label} must be between ${min} and ${max}`;
  return n;
}

export function parseLaunchInput(input: LaunchInput): ParseResult {
  if (!input.name.trim()) return { ok: false, error: "Name is required" };
  if (!input.symbol.trim()) return { ok: false, error: "Symbol is required" };
  const label = input.label.trim();
  if (!isValidLabel(label)) {
    return { ok: false, error: "Label must be 3 to 63 characters of a-z, 0-9 and hyphens, not starting or ending with a hyphen" };
  }
  let logoRef = ZERO_LOGO_REF;
  if (input.logoRef.trim() !== "") {
    try {
      logoRef = swarmReferenceToBytes32(input.logoRef);
    } catch (e) {
      return { ok: false, error: `Logo reference: ${e instanceof Error ? e.message : "invalid"}` };
    }
  }

  const baseFeeBps = int(input.baseFeeBps, "Base fee (bps)", MIN_FEE_BPS, MAX_FEE_BPS);
  if (typeof baseFeeBps === "string") return { ok: false, error: baseFeeBps };
  // Anti-sniper surcharge starts at most 80% (8000 bps).
  const sniperFeeStartBps = int(input.sniperFeeStartBps, "Sniper fee start (bps)", 0, 8000);
  if (typeof sniperFeeStartBps === "string") return { ok: false, error: sniperFeeStartBps };
  const sniperDecaySeconds = int(input.sniperDecaySeconds, "Sniper decay (seconds)", 0, 2 ** 32 - 1);
  if (typeof sniperDecaySeconds === "string") return { ok: false, error: sniperDecaySeconds };
  const startTick = int(input.startTick, "Start tick", -887272, 887272);
  if (typeof startTick === "string") return { ok: false, error: startTick };

  const quote = input.quoteAsset.trim() === "" ? EXTERNAL_ADDRESSES.weth : input.quoteAsset.trim();
  if (!isAddress(quote, { strict: false })) return { ok: false, error: "Quote asset must be an address" };

  let categoryMask: bigint;
  let regionMask: number;
  try {
    categoryMask = input.categories.length ? categoryMaskOf(input.categories) : ALL_CATEGORIES_MASK;
    regionMask = input.regions.length ? regionMaskOf(input.regions) : ALL_REGIONS_MASK;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid cause focus" };
  }

  const salt = input.salt.trim();
  if (salt !== "" && !(isHex(salt) && salt.length === 66)) {
    return { ok: false, error: "Salt must be empty or a 32-byte hex string" };
  }

  return {
    ok: true,
    params: {
      name: input.name.trim(),
      symbol: input.symbol.trim(),
      metadataURI: input.metadataURI.trim(),
      salt: salt === "" ? randomSalt() : (salt as Hex),
      baseFeeBps,
      sniperFeeStartBps,
      sniperDecaySeconds,
      startTick,
      quoteAsset: getAddress(quote.toLowerCase()),
      label,
      logoRef,
      categoryMask,
      regionMask,
    },
  };
}

/** Optional profile fields that go into the metadata document. */
export interface MetadataFields {
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

export const EMPTY_METADATA_FIELDS: MetadataFields = { description: "", website: "", twitter: "", telegram: "", discord: "" };

export type MetadataResult = { ok: true; doc: TokenMetadataDocument } | { ok: false; error: string };

const HANDLE = /^[^\s"'`]{1,64}$/;

/**
 * Builds the publisher's `TokenMetadata` document, applying the publisher's rules so the user sees
 * errors before uploading. The document never carries a wallet address.
 */
export function buildMetadataDocument(
  token: { name: string; symbol: string },
  logoRef: string,
  fields: MetadataFields,
): MetadataResult {
  const name = token.name.trim();
  const symbol = token.symbol.trim();
  if (name.length < 1 || name.length > 64) return { ok: false, error: "Name must be 1 to 64 characters" };
  if (!/^[A-Za-z0-9$._-]{1,16}$/.test(symbol)) return { ok: false, error: "Symbol must be 1 to 16 letters, digits or $._-" };
  let ref: string;
  try {
    ref = normalizeSwarmReference(logoRef);
  } catch {
    return { ok: false, error: "Upload a logo first (metadata needs its Swarm reference)" };
  }
  const doc: TokenMetadataDocument = { name, symbol, logoRef: ref };
  const description = fields.description.trim();
  if (description) {
    if (description.length > 2000) return { ok: false, error: "Description must be at most 2000 characters" };
    doc.description = description;
  }
  const website = fields.website.trim();
  if (website) {
    if (website.length > 256 || !/^https?:\/\/[^\s]+$/i.test(website)) return { ok: false, error: "Website must be an http(s) URL of at most 256 characters" };
    try {
      new URL(website);
    } catch {
      return { ok: false, error: "Website must be a valid URL" };
    }
    doc.website = website;
  }
  for (const key of ["twitter", "telegram"] as const) {
    const v = fields[key].trim().replace(/^@/, "");
    if (!v) continue;
    if (!HANDLE.test(v)) return { ok: false, error: `${key === "twitter" ? "Twitter" : "Telegram"} must be at most 64 characters with no spaces or quotes` };
    doc[key] = v;
  }
  const discord = fields.discord.trim();
  if (discord) {
    if (discord.length > 256) return { ok: false, error: "Discord must be at most 256 characters" };
    doc.discord = discord;
  }
  return { ok: true, doc };
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
