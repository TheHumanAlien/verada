import {
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  namehash,
  type Hex,
  type PublicClient,
} from "viem";
import { normalize } from "viem/ens";

/**
 * EIP-1577 / ENSIP-7 Swarm contenthash:
 *   <0xe4 varint = e401> <cidv1 = 01> <swarm-manifest = fa01> <keccak-256 = 1b> <len = 20> <32-byte reference>
 */
export const SWARM_CONTENTHASH_PREFIX = "0xe40101fa011b20" as const;

/** ENS registry, same address on Ethereum mainnet and Sepolia (ENS deployments docs). */
export const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

const registryAbi = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const resolverAbi = parseAbi([
  "function contenthash(bytes32 node) view returns (bytes)",
  "function setContenthash(bytes32 node, bytes hash)",
]);

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

export function setContenthashCalldata(name: string, ref: string) {
  const node = ensNamehash(name);
  const contenthash = swarmReferenceToContenthash(ref);
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "setContenthash", args: [node, contenthash] });
  return { name: normalize(name), node, contenthash, data };
}

/** Read-only registry lookup of the resolver for a name. */
export async function lookupResolver(client: PublicClient, name: string, registry: Hex = ENS_REGISTRY): Promise<Hex> {
  const node = ensNamehash(name);
  const addr = await client.readContract({ address: registry, abi: registryAbi, functionName: "resolver", args: [node] });
  if (/^0x0{40}$/.test(addr)) throw new Error(`no resolver set for ${name}`);
  return addr;
}

/** Read-only: current contenthash bytes of a name ("0x" when unset). */
export async function readContenthash(client: PublicClient, name: string, resolver?: Hex): Promise<Hex> {
  const addr = resolver ?? (await lookupResolver(client, name));
  return (await client.readContract({
    address: addr,
    abi: resolverAbi,
    functionName: "contenthash",
    args: [ensNamehash(name)],
  })) as Hex;
}

export { decodeFunctionResult };
