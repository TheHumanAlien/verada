import { keccak256, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { BALLOT_LOG_CHUNK, chainEpochDetail, chainEpochOptions } from "@/lib/chain-reads";
import { envDefaults } from "@/lib/config";

const GOV = "0x00000000000000000000000000000000000000e1" as const;
const TOKEN = "0x000000000000000000000000000000000000aa01" as const;

// Head block 1,000,000 at timestamp 20,000,000; epoch 4 started 3 days (21,600 slots) earlier.
const HEAD = { number: 1_000_000n, timestamp: 20_000_000n };
const START = HEAD.timestamp - 3n * 86_400n;
const FIRST = HEAD.number - 21_601n;

describe("chainEpochOptions", () => {
  const cfg = { ...envDefaults(), governorAddress: GOV, factoryDeployBlock: 123n } as const;
  const a = `0x${"11".repeat(32)}` as Hex;
  const b = `0x${"22".repeat(32)}` as Hex;
  const getBlock = vi.fn(async () => HEAD);

  it("scans only the current epoch's blocks, chunk by chunk, and returns cause ids", async () => {
    const ranges: [bigint, bigint][] = [];
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return fromBlock <= FIRST + 12_000n && FIRST + 12_000n <= toBlock ? [{ args: { token: TOKEN, epoch: 4n, orgIds: [a, b] } }] : [];
    });
    const client = { getBlock, getLogs } as unknown as PublicClient;
    expect(await chainEpochOptions(client, cfg, TOKEN, 4n, START)).toEqual([keccak256(a), keccak256(b)]);
    expect(ranges).toEqual([
      [FIRST, FIRST + BALLOT_LOG_CHUNK - 1n],
      [FIRST + BALLOT_LOG_CHUNK, FIRST + 2n * BALLOT_LOG_CHUNK - 1n],
      [FIRST + 2n * BALLOT_LOG_CHUNK, FIRST + 3n * BALLOT_LOG_CHUNK - 1n],
    ]);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: GOV, args: { token: TOKEN, epoch: 4n } }));
  });

  it("is empty when no ballot log exists, after scanning up to the head", async () => {
    const ranges: [bigint, bigint][] = [];
    const getLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => (ranges.push([fromBlock, toBlock]), []);
    const client = { getBlock, getLogs } as unknown as PublicClient;
    expect(await chainEpochOptions(client, cfg, TOKEN, 4n, START)).toEqual([]);
    expect(ranges.at(0)?.[0]).toBe(FIRST);
    expect(ranges.at(-1)?.[1]).toBe(HEAD.number);
  });

  it("never scans below the factory deploy block", async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getBlock, getLogs } as unknown as PublicClient;
    await chainEpochOptions(client, { ...cfg, factoryDeployBlock: HEAD.number - 100n }, TOKEN, 4n, START);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: HEAD.number - 100n, toBlock: HEAD.number }));
  });
});

describe("chainEpochDetail", () => {
  const cfg = { ...envDefaults(), governorAddress: GOV } as const;
  const views: Record<string, unknown> = {
    isOpened: false,
    isClosed: false,
    isFinalized: false,
    snapshotFor: START - 1n,
    epochStart: START,
    voterCount: 0n,
    isPrepared: true,
    poolOf: [`0x${"00".repeat(32)}`, 40n],
  };
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => views[functionName]);

  it("keeps the epoch state when the ballot log cannot be read", async () => {
    const getLogs = async () => {
      throw new Error("Archive requests require a personal token");
    };
    const client = { readContract, getBlock: async () => HEAD, getLogs } as unknown as PublicClient;
    const d = await chainEpochDetail(client, cfg, TOKEN, 4n);
    expect(d).toMatchObject({ epoch: "4", prepared: true, options: [], ballotUnavailable: true, poolSize: "40", start: Number(START) });
  });

  it("does not flag a readable ballot", async () => {
    const client = { readContract, getBlock: async () => HEAD, getLogs: async () => [] } as unknown as PublicClient;
    const d = await chainEpochDetail(client, cfg, TOKEN, 4n);
    expect(d.ballotUnavailable).toBeUndefined();
  });
});
