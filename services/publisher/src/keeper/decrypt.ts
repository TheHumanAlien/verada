import { encodeAbiParameters, type Hex, type PublicClient } from "viem";

/** Result of a Zama public decryption, as the relayer SDK returns it. */
export interface PublicDecryption {
  /** Decrypted values keyed by handle. */
  readonly clearValues: Readonly<Record<string, unknown>>;
  /** `abi.encode(v0, v1, ...)` in input-handle order, exactly what the KMS signed. */
  readonly abiEncodedClearValues: Hex;
  /** KMS signatures over `(handles, abiEncodedClearValues)`. */
  readonly decryptionProof: Hex;
}

/** Off-chain public decryption of publicly decryptable ciphertext handles. */
export interface PublicDecryptor {
  publicDecrypt(handles: readonly Hex[]): Promise<PublicDecryption>;
  dispose?(): void;
}

/** Largest packed tally word: three 40-bit counters (`ZamaVotingScheme` `MAX_WORD`). */
const MAX_WORD = (1n << 120n) - 1n;

/** `abi.encode(uint256 v0, uint256 v1, ...)`: one 32-byte word per value. */
export function encodeCleartexts(values: readonly bigint[]): Hex {
  if (values.length === 0) return "0x";
  return encodeAbiParameters(
    values.map(() => ({ type: "uint256" })),
    values,
  );
}

/** Splits `abi.encode` of static words back into values. */
export function decodeCleartexts(data: Hex): bigint[] {
  const body = data.slice(2);
  if (body.length % 64 !== 0) throw new DecryptionMismatch("cleartexts are not whole 32-byte words");
  const out: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return out;
}

export class DecryptionMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionMismatch";
  }
}

const asBigint = (v: unknown): bigint | undefined => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return undefined;
};

/**
 * Checks a decryption against the handles it was requested for, the way `ZamaVotingScheme.submitTally`
 * will: one word per handle, each fitting 120 bits (three packed 40-bit counters), and (when the SDK
 * returns them) each word equal to
 * the clear value of the handle at the same index. Returns the cleartexts to submit unchanged, since
 * the KMS signature covers those exact bytes.
 */
export function checkDecryption(handles: readonly Hex[], r: PublicDecryption): { cleartexts: Hex; values: bigint[] } {
  const values = decodeCleartexts(r.abiEncodedClearValues);
  if (values.length !== handles.length) {
    throw new DecryptionMismatch(`expected ${handles.length} words, got ${values.length}`);
  }
  const byHandle = new Map(Object.entries(r.clearValues ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  handles.forEach((h, i) => {
    if (values[i]! > MAX_WORD) throw new DecryptionMismatch(`word ${i} exceeds 120 bits`);
    if (byHandle.size === 0) return;
    const clear = asBigint(byHandle.get(h.toLowerCase()));
    if (clear === undefined) throw new DecryptionMismatch(`no clear value for handle ${i}`);
    if (clear !== values[i]) throw new DecryptionMismatch(`word ${i} does not match its handle`);
  });
  if (!/^0x[0-9a-fA-F]*$/.test(r.decryptionProof) || r.decryptionProof.length <= 2) {
    throw new DecryptionMismatch("empty decryption proof");
  }
  return { cleartexts: r.abiEncodedClearValues, values };
}

/** In-memory decryptor for tests: looks each handle up in `values` and returns a fixed proof. */
export function createFakeDecryptor(
  values: ReadonlyMap<string, bigint> | ((handle: Hex) => bigint),
  opts: { proof?: Hex; fail?: () => Error | undefined } = {},
): PublicDecryptor & { calls: Hex[][] } {
  const calls: Hex[][] = [];
  const lookup = typeof values === "function" ? values : (h: Hex) => {
    const v = values.get(h.toLowerCase());
    if (v === undefined) throw new Error("unknown handle");
    return v;
  };
  return {
    calls,
    async publicDecrypt(handles) {
      calls.push([...handles]);
      const err = opts.fail?.();
      if (err) throw err;
      const vals = handles.map(lookup);
      return {
        clearValues: Object.fromEntries(handles.map((h, i) => [h, vals[i]])),
        abiEncodedClearValues: encodeCleartexts(vals),
        decryptionProof: opts.proof ?? "0x01",
      };
    },
  };
}

export const ZAMA_CHAIN_IDS = { mainnet: 1 } as const;

export interface ZamaDecryptorOptions {
  chainId: number;
  /** Host-chain public client; the SDK reads the ACL/KMS protocol version through it. */
  publicClient: PublicClient;
  /** Host-chain RPC URL handed to the chain preset (`FheChain.network`). */
  rpcUrl: string;
  /** Overrides the preset's `relayerUrl`. */
  relayerUrl?: string;
  /** Zama relayer API key, sent with the SDK's `ApiKeyHeader` auth. */
  apiKey?: string;
  /** Upper bound for one decryption round-trip including the relayer's polling. */
  timeoutMs?: number;
}

/**
 * Public decryption through `@zama-fhe/sdk` (Node transport, which drives `@fhevm/sdk`):
 * `new ZamaSDK(createConfig({ chains, provider, relayers: { [id]: node() } }))` with no signer, then
 * `sdk.decryption.decryptPublicValues(handles)`. The SDK is imported lazily so that processes not
 * running the keeper never load its WASM. A failed SDK init does not recover, so the instance is
 * dropped and rebuilt after any failure.
 */
export function createZamaDecryptor(opts: ZamaDecryptorOptions): PublicDecryptor {
  if (opts.chainId !== ZAMA_CHAIN_IDS.mainnet) {
    throw new Error(`Zama public decryption is only configured for Ethereum mainnet (chain 1), not ${opts.chainId}`);
  }
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  type Sdk = { decryption: { decryptPublicValues(h: Hex[], o?: { timeout?: number }): Promise<PublicDecryption> }; dispose?(): void };
  let sdk: Promise<Sdk> | undefined;

  const build = async (): Promise<Sdk> => {
    const [core, nodeMod, viemMod] = await Promise.all([
      import("@zama-fhe/sdk"),
      import("@zama-fhe/sdk/node"),
      import("@zama-fhe/sdk/viem"),
    ]);
    const preset = core.mainnet;
    const chain = {
      ...preset,
      network: opts.rpcUrl,
      relayerUrl: opts.relayerUrl ?? preset.relayerUrl,
      ...(opts.apiKey ? { auth: { __type: "ApiKeyHeader" as const, value: opts.apiKey } } : {}),
    };
    const config = core.createConfig({
      chains: [chain],
      provider: new viemMod.ViemProvider({ publicClient: opts.publicClient }),
      relayers: { [chain.id]: nodeMod.node({ timeout }) } as Record<typeof chain.id, ReturnType<typeof nodeMod.node>>,
      telemetry: false,
    });
    return new core.ZamaSDK(config) as unknown as Sdk;
  };

  return {
    async publicDecrypt(handles) {
      sdk ??= build();
      try {
        const instance = await sdk;
        return await instance.decryption.decryptPublicValues([...handles], { timeout });
      } catch (err) {
        const failed = sdk;
        sdk = undefined;
        failed?.then((s) => s.dispose?.()).catch(() => {});
        throw err;
      }
    },
    dispose() {
      sdk?.then((s) => s.dispose?.()).catch(() => {});
      sdk = undefined;
    },
  };
}
