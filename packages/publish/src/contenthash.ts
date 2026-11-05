import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  namehash,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { normalize, packetToBytes } from "viem/ens";

/**
 * EIP-1577 / ENSIP-7 Swarm contenthash:
 *   <0xe4 varint = e401> <cidv1 = 01> <swarm-manifest = fa01> <keccak-256 = 1b> <len = 20> <32-byte reference>
 */
export const SWARM_CONTENTHASH_PREFIX = "0xe40101fa011b20" as const;

/**
 * ENSv1 registry (mainnet). Kept for names that still live on the v1 registry; new
 * `.eth` names are registered on ENSv2 and resolved through the Universal Resolver below.
 * @deprecated use {@link ENS_V2} and {@link lookupResolver}.
 */
export const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

/** ENSv2 mainnet contracts (docs.ens.domains/learn/deployments; same values as `@verada/sdk`). */
export const ENS_V2 = {
  ethRegistry: "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2" as Hex,
  /** Canonical Universal Resolver proxy; stable across upgrades. */
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as Hex,
} as const;

const resolverAbi = parseAbi([
  "function contenthash(bytes32 node) view returns (bytes)",
  "function setContenthash(bytes32 node, bytes hash)",
]);
const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes result, address resolver)",
]);
const profileRegistryAbi = parseAbi(["function setDefaultContenthash(bytes hash)"]);

export function normalizeReference(input: string): string {
  const ref = input.trim().replace(/^bzz:\/\//i, "").replace(/^0x/i, "").toLowerCase();
  if (ref.length === 128) {
    throw new Error("encrypted (128 hex char) references cannot be used in an ENS contenthash; upload without encryption");
  }
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error("Swarm reference must be 64 hex characters");
  return ref;
}

export function swarmReferenceToContenthash(ref: string): Hex {
  return `${SWARM_CONTENTHASH_PREFIX}${normalizeReference(ref)}` as Hex;
}

/** Returns the 64-char reference, or throws if the bytes are not a Swarm contenthash. */
export function contenthashToSwarmReference(hex: string): string {
  const h = hex.toLowerCase();
  if (!h.startsWith(SWARM_CONTENTHASH_PREFIX) || h.length !== SWARM_CONTENTHASH_PREFIX.length + 64) {
    throw new Error("not a Swarm (0xe4, cidv1, swarm-manifest, keccak-256) contenthash");
  }
  return h.slice(SWARM_CONTENTHASH_PREFIX.length);
}

export function ensNamehash(name: string): Hex {
  return namehash(normalize(name));
}

/** DNS wire-format encoding used by ENSIP-10 `resolve(bytes name, bytes data)`. */
export function dnsEncode(name: string): Hex {
  const bytes = packetToBytes(normalize(name));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Calldata for a standard resolver's `setContenthash(bytes32 node, bytes hash)`. Use this when
 * the name sits on an ENS public resolver. Names served by the Verada resolver use
 * {@link setDefaultContenthashCalldata} instead.
 */
export function setContenthashCalldata(name: string, ref: string) {
  const node = ensNamehash(name);
  const contenthash = swarmReferenceToContenthash(ref);
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "setContenthash", args: [node, contenthash] });
  return { name: normalize(name), node, contenthash, data };
}

/**
 * Calldata for `TokenProfileRegistry.setDefaultContenthash(bytes hash)`: the single contenthash
 * the Verada resolver serves for `varada.eth` and, by default, every `<label>.varada.eth`. Only
 * the registry owner may send it. Point it at the site's feed manifest so it never changes.
 */
export function setDefaultContenthashCalldata(registry: Hex, ref: string) {
  const contenthash = swarmReferenceToContenthash(ref);
  const data = encodeFunctionData({ abi: profileRegistryAbi, functionName: "setDefaultContenthash", args: [contenthash] });
  return { to: registry, contenthash, data };
}

/**
 * Read-only resolver lookup through the ENSv2 Universal Resolver, which walks the registry
 * hierarchy (v1 names included) and reports the resolver that answers for the name.
 */
export async function lookupResolver(
  client: PublicClient,
  name: string,
  universalResolver: Hex = ENS_V2.universalResolver,
): Promise<Hex> {
  const { resolver } = await resolveContenthash(client, name, universalResolver);
  if (/^0x0{40}$/.test(resolver)) throw new Error(`no resolver set for ${name}`);
  return resolver;
}

async function resolveContenthash(client: PublicClient, name: string, universalResolver: Hex) {
  const normalized = normalize(name);
  const call = encodeFunctionData({ abi: resolverAbi, functionName: "contenthash", args: [namehash(normalized)] });
  const [result, resolver] = await client.readContract({
    address: universalResolver,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsEncode(normalized), call],
  });
  const [hash] = decodeAbiParameters([{ type: "bytes" }], result);
  return { hash, resolver };
}

/**
 * Read-only: current contenthash bytes of a name ("0x" when unset). Resolves through the
 * Universal Resolver unless a resolver address is given, in which case it is called directly.
 */
export async function readContenthash(client: PublicClient, name: string, resolver?: Hex): Promise<Hex> {
  if (!resolver) return (await resolveContenthash(client, name, ENS_V2.universalResolver)).hash;
  return (await client.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: "contenthash",
    args: [ensNamehash(name)],
  })) as Hex;
}

export { decodeFunctionResult };
