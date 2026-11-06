import { keccak256, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { chainEpochOptions } from "@/lib/chain-reads";
import { envDefaults } from "@/lib/config";

const GOV = "0x00000000000000000000000000000000000000e1" as const;
const TOKEN = "0x000000000000000000000000000000000000aa01" as const;

describe("chainEpochOptions", () => {
  const cfg = { ...envDefaults(), governorAddress: GOV, factoryDeployBlock: 123n } as const;
  const a = `0x${"11".repeat(32)}` as Hex;
  const b = `0x${"22".repeat(32)}` as Hex;

  it("reads the options from the epoch's BallotPrepared log as cause ids", async () => {
    const getLogs = vi.fn(async () => [{ args: { token: TOKEN, epoch: 4n, orgIds: [a, b] } }]);
    const client = { getLogs } as unknown as PublicClient;
    expect(await chainEpochOptions(client, cfg, TOKEN, 4n)).toEqual([keccak256(a), keccak256(b)]);
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: GOV, args: { token: TOKEN, epoch: 4n }, fromBlock: 123n, toBlock: "latest" }),
    );
  });

  it("is empty when no ballot log exists", async () => {
    const client = { getLogs: async () => [] } as unknown as PublicClient;
    expect(await chainEpochOptions(client, cfg, TOKEN, 4n)).toEqual([]);
  });
});
