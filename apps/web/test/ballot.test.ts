import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { decodeFheBallot } from "@verada/sdk";

const handle = `0x${"22".repeat(32)}` as const;
const encrypt = vi.fn(async (_p: unknown) => ({ encryptedValues: [handle], inputProof: "0xabcdef" }));
const sdkConfigs: Record<string, unknown>[] = [];

vi.mock("@zama-fhe/sdk", () => ({
  ZamaSDK: class {
    constructor(cfg: Record<string, unknown>) {
      sdkConfigs.push(cfg);
    }
    encrypt = encrypt;
  },
  createConfig: (p: unknown) => p,
  memoryStorage: { kind: "memory" },
}));
vi.mock("@zama-fhe/sdk/web", () => ({ web: (o: unknown) => ({ type: "web", options: o }) }));
vi.mock("@zama-fhe/sdk/viem", () => ({
  ViemProvider: class {
    constructor(readonly cfg: unknown) {}
  },
}));
vi.mock("@zama-fhe/sdk/chains", () => ({
  mainnet: { id: 1, relayerUrl: "https://relayer.mainnet.zama.org", network: "https://direct-rpc.example" },
}));

const { buildFheBallot, createZamaEncryptor, lazyEncryptor } = await import("@/lib/ballot");

const scheme = "0x00000000000000000000000000000000000000c1";
const voter = "0x00000000000000000000000000000000000000a1";

function fakeClient() {
  return { request: vi.fn(async () => "0x1") } as unknown as PublicClient & { request: ReturnType<typeof vi.fn> };
}

describe("Zama ballot encryption", () => {
  beforeEach(() => {
    encrypt.mockClear();
    sdkConfigs.length = 0;
  });

  it("encrypts the option index as euint8 bound to the scheme and voter", async () => {
    const enc = await createZamaEncryptor({ chainId: 1, publicClient: fakeClient() });
    const ballot = await buildFheBallot(enc, { contractAddress: scheme, userAddress: voter, choice: 3 });
    expect(encrypt).toHaveBeenCalledWith({ values: [{ type: "euint8", value: 3n }], contractAddress: scheme, userAddress: voter });
    expect(decodeFheBallot(ballot)).toEqual({ handle, inputProof: "0xabcdef" });
  });

  it("routes the SDK's chain reads through the given (private) client, keeps nothing and sends no telemetry", async () => {
    const client = fakeClient();
    await createZamaEncryptor({ chainId: 1, publicClient: client });
    const cfg = sdkConfigs[0] as { chains: { network: unknown; relayerUrl: string }[]; telemetry: boolean; storage: unknown; relayers: Record<number, { options: Record<string, unknown> }> };
    const network = cfg.chains[0]!.network as { request(a: unknown): Promise<unknown> };
    expect(typeof network).toBe("object");
    await network.request({ method: "eth_chainId" });
    expect(client.request).toHaveBeenCalledWith({ method: "eth_chainId" });
    expect(cfg.chains[0]!.relayerUrl).toBe("https://relayer.mainnet.zama.org");
    expect(cfg.telemetry).toBe(false);
    expect(cfg.storage).toEqual({ kind: "memory" });
    expect(cfg.relayers[1]!.options).toMatchObject({ offloadEncrypt: false });
  });

  it("honours a relayer override", async () => {
    await createZamaEncryptor({ chainId: 1, publicClient: fakeClient(), relayerUrl: "https://proxy.example/relayer" });
    const cfg = sdkConfigs[0] as { chains: { id: number; relayerUrl: string }[] };
    expect(cfg.chains[0]).toMatchObject({ id: 1, relayerUrl: "https://proxy.example/relayer" });
  });

  it("rejects testnets: mainnet only", async () => {
    await expect(createZamaEncryptor({ chainId: 11155111, publicClient: fakeClient() })).rejects.toThrow(/chain 11155111/);
  });

  it("rejects unsupported chains and invalid choices", async () => {
    await expect(createZamaEncryptor({ chainId: 10, publicClient: fakeClient() })).rejects.toThrow(/chain 10/);
    const enc = await createZamaEncryptor({ chainId: 1, publicClient: fakeClient() });
    await expect(buildFheBallot(enc, { contractAddress: scheme, userAddress: voter, choice: 32 })).rejects.toThrow();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("creates the SDK once per chain and relayer", async () => {
    const client = fakeClient();
    const opts: { relayerUrl?: string } = {};
    const get = lazyEncryptor(() => ({ chainId: 1, publicClient: client, relayerUrl: opts.relayerUrl }));
    const a = await get();
    expect(await get()).toBe(a);
    opts.relayerUrl = "https://other.example";
    expect(await get()).not.toBe(a);
    expect(sdkConfigs).toHaveLength(2);
  });
});
