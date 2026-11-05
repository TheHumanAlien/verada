import type { Hex } from "viem";

/**
 * EIP-1577 / ENSIP-7 Swarm contenthash prefix:
 * `0xe4` (swarm namespace, varint `e401`) · `01` (CIDv1) · `fa01` (swarm-manifest multicodec) ·
 * `1b` (keccak-256 multihash) · `20` (32 bytes), followed by the 32-byte reference.
 */
export const SWARM_CONTENTHASH_PREFIX = "0xe40101fa011b20" as const;

/** Unencrypted Swarm references are 32 bytes (64 hex chars). */
export const SWARM_REFERENCE_HEX_LENGTH = 64;
/** Encrypted references carry a 32-byte decryption key after the address (128 hex chars). */
export const SWARM_ENCRYPTED_REFERENCE_HEX_LENGTH = 128;

const HEX = /^[0-9a-f]+$/;

/** Strips `bzz://` and `0x`, lowercases. Does not validate. */
export function stripSwarmReference(input: string): string {
  return input
    .trim()
    .replace(/^bzz:\/\//i, "")
    .replace(/^0x/i, "")
    .toLowerCase();
}

/** Whether `input` is a plain (unencrypted) 64-hex Swarm reference, with or without prefixes. */
export function isSwarmReference(input: string): boolean {
  const ref = stripSwarmReference(input);
  return ref.length === SWARM_REFERENCE_HEX_LENGTH && HEX.test(ref);
}

/** Whether `input` is an encrypted 128-hex Swarm reference. */
export function isEncryptedSwarmReference(input: string): boolean {
  const ref = stripSwarmReference(input);
  return ref.length === SWARM_ENCRYPTED_REFERENCE_HEX_LENGTH && HEX.test(ref);
}

/**
 * Normalizes a Swarm reference to 64 lowercase hex chars without prefix.
 * Encrypted references are rejected: their key must never land on-chain or in a public URL.
 */
export function normalizeSwarmReference(input: string): string {
  const ref = stripSwarmReference(input);
  if (ref.length === SWARM_ENCRYPTED_REFERENCE_HEX_LENGTH && HEX.test(ref)) {
    throw new Error("encrypted (128 hex char) Swarm references cannot be published; upload without encryption");
  }
  if (ref.length !== SWARM_REFERENCE_HEX_LENGTH || !HEX.test(ref)) {
    throw new Error("Swarm reference must be 64 hex characters");
  }
  return ref;
}

/** `bzz://<ref>` URI. */
export function bzzUri(ref: string): string {
  return `bzz://${normalizeSwarmReference(ref)}`;
}

/** The reference as a `0x`-prefixed bytes32, as stored on-chain (`logoRef`). */
export function swarmReferenceToBytes32(ref: string): Hex {
  return `0x${normalizeSwarmReference(ref)}`;
}

/** Inverse of {@link swarmReferenceToBytes32}; returns null for the zero reference. */
export function bytes32ToSwarmReference(value: Hex): string | null {
  const ref = stripSwarmReference(value);
  if (/^0+$/.test(ref)) return null;
  return normalizeSwarmReference(ref);
}

/** EIP-1577 contenthash bytes for a Swarm manifest reference. */
export function swarmContenthash(ref: string): Hex {
  return `${SWARM_CONTENTHASH_PREFIX}${normalizeSwarmReference(ref)}`;
}

/** Whether `hex` is a Swarm manifest contenthash. */
export function isSwarmContenthash(hex: string): boolean {
  const h = hex.toLowerCase();
  return (
    h.startsWith(SWARM_CONTENTHASH_PREFIX) &&
    h.length === SWARM_CONTENTHASH_PREFIX.length + SWARM_REFERENCE_HEX_LENGTH &&
    HEX.test(h.slice(SWARM_CONTENTHASH_PREFIX.length))
  );
}

/** Extracts the 64-hex reference from a Swarm contenthash; throws for other codecs. */
export function swarmReferenceFromContenthash(hex: string): string {
  if (!isSwarmContenthash(hex)) {
    throw new Error("not a Swarm (0xe4, cidv1, swarm-manifest, keccak-256) contenthash");
  }
  return hex.toLowerCase().slice(SWARM_CONTENTHASH_PREFIX.length);
}

/**
 * Gateway URL for a reference, e.g. `https://gw.example/bzz/<ref>/logo.png`.
 * The base may or may not end with a slash; `path` must not start with one.
 */
export function swarmGatewayUrl(gatewayBase: string, ref: string, path = ""): string {
  const base = gatewayBase.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${base}/bzz/${normalizeSwarmReference(ref)}/${normalizedPath}`;
}
