import { keccak256, type Hex } from "viem";

export interface OrgIdentity {
  id?: string | null;
  ein?: string | null;
}

const EIN_DIGITS = /^\d{9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Endaoment orgId for a US organization: the EIN digits (hyphen removed) as ASCII
 * bytes, left-aligned and right-padded with zeros to 32 bytes.
 */
export function einToOrgId(ein: string): Hex {
  const digits = ein.replace(/-/g, "").trim();
  if (!EIN_DIGITS.test(digits)) throw new Error(`invalid EIN: ${ein}`);
  let hex = "";
  for (const ch of digits) hex += ch.charCodeAt(0).toString(16);
  return `0x${hex.padEnd(64, "0")}` as Hex;
}

/**
 * orgId for an organization without an EIN: the Endaoment UUID with hyphens removed,
 * read as 16 bytes and left-aligned in bytes32. Always cross-check the result with
 * `verifyOrgAddress`, which compares it to the factory's computeOrgAddress.
 */
export function uuidToOrgId(id: string): Hex {
  const trimmed = id.trim();
  if (!UUID.test(trimmed)) throw new Error(`invalid organization id: ${id}`);
  return `0x${trimmed.replace(/-/g, "").toLowerCase().padEnd(64, "0")}` as Hex;
}

/** On-chain orgId: EIN rule when an EIN is present, otherwise the UUID rule. */
export function toOrgId(org: OrgIdentity): Hex {
  if (org.ein?.trim()) return einToOrgId(org.ein);
  if (org.id?.trim()) return uuidToOrgId(org.id);
  throw new Error("organization has neither ein nor id");
}

/** causeId = keccak256 of the 32-byte orgId, so it is derivable from on-chain data alone. */
export function toCauseId(org: OrgIdentity): Hex {
  return keccak256(toOrgId(org));
}
