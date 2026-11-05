/**
 * Encrypted ballots for `ZamaVotingScheme`. The voter's option index is encrypted in the browser
 * with `@zama-fhe/sdk` as an `euint8` input bound to `(scheme address, voter address)`, then sent
 * by the voter as `castBallot(governor, token, scope, encodeFheBallot(handle, inputProof))`.
 *
 * The SDK (and the TFHE WASM it embeds as base64) is loaded with a dynamic import on the first
 * ballot, so pages that never vote never download it.
 *
 * What leaves the browser while encrypting:
 *  - Host-chain reads the SDK needs (protocol and key versions): through the private RPC,
 *    public scope, like every other global read.
 *  - The FHE public key and CRS (tens of MB) from the relayer's key URL, and the input-proof
 *    request to the Zama relayer. These are direct HTTPS requests: the relayer sees the IP,
 *    the scheme address and the voter address (both also public in the transaction moments later),
 *    never the choice. `zamaRelayerUrl` can point at an operator proxy instead.
 */
import { assertOption, encodeFheBallot } from "@verada/sdk";
import type { Address, EIP1193Provider, Hex, PublicClient } from "viem";

export interface EncryptChoiceParams {
  /** The voting scheme contract; the input proof is bound to it. */
  contractAddress: Address;
  /** The voter; the input proof is bound to them, so they must send the transaction. */
  userAddress: Address;
  /** Option index in `[0, MAX_BALLOT_OPTIONS)`. */
  choice: number;
}

export interface EncryptedChoice {
  handle: Hex;
  inputProof: Hex;
}

export interface Encryptor {
  encryptChoice(params: EncryptChoiceParams): Promise<EncryptedChoice>;
}

export interface ZamaEncryptorOptions {
  chainId: number;
  /** Public-scope client over the private RPC; backs the SDK's host-chain reads. */
  publicClient: PublicClient;
  relayerUrl?: string;
}

/** Verada runs on Ethereum mainnet only; the Zama mainnet preset is the one supported chain. */
export const ZAMA_CHAIN_IDS = [1, 11155111] as const;

/** Builds the ballot bytes for an encrypted choice. */
export function fheBallot({ handle, inputProof }: EncryptedChoice): Hex {
  return encodeFheBallot(handle, inputProof);
}

/** Encrypts `choice` and returns the ballot bytes to pass to `castBallot`. */
export async function buildFheBallot(encryptor: Encryptor, params: EncryptChoiceParams): Promise<Hex> {
  assertOption(params.choice);
  return fheBallot(await encryptor.encryptChoice(params));
}

/**
 * Creates an encryptor backed by `@zama-fhe/sdk`. Read-only SDK (no signer): encryption needs no
 * signature, only the voter's address. Nothing is persisted: storage is in memory and telemetry
 * headers are off.
 */
export async function createZamaEncryptor(opts: ZamaEncryptorOptions): Promise<Encryptor> {
  const [{ ZamaSDK, createConfig, memoryStorage }, { web }, { ViemProvider }, fheChains] = await Promise.all([
    import("@zama-fhe/sdk"),
    import("@zama-fhe/sdk/web"),
    import("@zama-fhe/sdk/viem"),
    import("@zama-fhe/sdk/chains"),
  ]);
  const preset = opts.chainId === 1 ? fheChains.mainnet : undefined;
  if (!preset) throw new Error(`Encrypted voting is not available on chain ${opts.chainId}`);

  // EIP-1193 view of the private public-scope client, so the SDK's reads never go direct.
  const network = { request: (args: unknown) => opts.publicClient.request(args as never) } as unknown as EIP1193Provider;
  const chain = { ...preset, network, relayerUrl: opts.relayerUrl ?? preset.relayerUrl };
  const config = createConfig({
    chains: [chain],
    provider: new ViemProvider({ publicClient: opts.publicClient }),
    storage: memoryStorage,
    telemetry: false,
    // Main-thread encryption: the static export cannot rely on a bundler-relocated worker URL.
    relayers: { [chain.id]: web({ offloadEncrypt: false, batchRpcCalls: true }) } as Record<typeof chain.id, ReturnType<typeof web>>,
  });
  const sdk = new ZamaSDK(config);

  return {
    async encryptChoice({ contractAddress, userAddress, choice }) {
      assertOption(choice);
      const { encryptedValues, inputProof } = await sdk.encrypt({
        values: [{ type: "euint8", value: BigInt(choice) }],
        contractAddress,
        userAddress,
      });
      const handle = encryptedValues[0];
      if (!handle) throw new Error("Zama SDK returned no encrypted value");
      return { handle, inputProof };
    },
  };
}

/** One lazily created encryptor per (chain, relayer); a failed init is retried on the next call. */
export function lazyEncryptor(opts: () => ZamaEncryptorOptions): () => Promise<Encryptor> {
  let pending: Promise<Encryptor> | undefined;
  let key = "";
  return () => {
    const o = opts();
    const k = `${o.chainId}|${o.relayerUrl ?? ""}`;
    if (!pending || k !== key) {
      key = k;
      const p = createZamaEncryptor(o);
      pending = p;
      p.catch(() => {
        if (pending === p) pending = undefined;
      });
    }
    return pending;
  };
}
