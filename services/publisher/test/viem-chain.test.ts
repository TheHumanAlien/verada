import { ballotCommitment } from "@verada/sdk";
import { epochGovernorAbi } from "@verada/sdk/abis";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  hexToBigInt,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { createViemChain } from "../src/keeper/viem-chain.js";

const EG = "0x00000000000000000000000000000000000000e1" as Address;
const TOKEN = "0x000000000000000000000000000000000000aa01" as Address;
const KEY = `0x${"11".repeat(32)}` as Hex;
const ORGS = [0, 1, 2].map((i) => keccak256(toHex(`org-${i}`)));

/**
 * A chain of 12-second blocks from timestamp 1000 with 100-block epochs. The governor's
 * `BallotPrepared` for (TOKEN, 2) is in block 250, inside epoch 2 (blocks 200..299).
 */
function fakeRpc(opts: { commitment?: Hex; logBlock?: bigint } = {}) {
  const latest = 1_000n;
  const logBlock = opts.logBlock ?? 250n;
  const ts = (n: bigint) => 1_000n + 12n * n;
  const ranges: [bigint, bigint][] = [];
  const topics = encodeEventTopics({ abi: epochGovernorAbi, eventName: "BallotPrepared", args: { token: TOKEN, epoch: 2n } });
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return toHex(31337);
        case "eth_blockNumber":
          return toHex(latest);
        case "eth_getBlockByNumber": {
          const n = hexToBigInt(params[0] as Hex);
          return { number: toHex(n), timestamp: toHex(ts(n)), hash: keccak256(toHex(n)), parentHash: keccak256(toHex(n - 1n)), transactions: [] };
        }
        case "eth_call": {
          const { data } = params[0] as { data: Hex };
          const call = decodeFunctionData({ abi: epochGovernorAbi, data });
          if (call.functionName === "epochStart") {
            return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "epochStart", result: 1_000n + (call.args![0] as bigint) * 1_200n });
          }
          if (call.functionName === "ballotCommitment") {
            return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "ballotCommitment", result: [opts.commitment ?? ballotCommitment(ORGS), ORGS.length] });
          }
          throw new Error(`unexpected call ${call.functionName}`);
        }
        case "eth_getLogs": {
          const f = params[0] as { fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
          const from = hexToBigInt(f.fromBlock);
          const to = hexToBigInt(f.toBlock);
          ranges.push([from, to]);
          expect(f.topics).toEqual(topics);
          if (logBlock < from || logBlock > to) return [];
          return [
            {
              address: EG,
              topics,
              data: encodeAbiParameters(
                [{ type: "uint32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32[]" }],
                [1, 50n, 0, ORGS],
              ),
              blockNumber: toHex(logBlock),
              blockHash: keccak256(toHex(logBlock)),
              transactionHash: keccak256(toHex("tx")),
              transactionIndex: "0x0",
              logIndex: "0x0",
              removed: false,
            },
          ];
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { transport, ranges };
}

const chainWith = (rpc: ReturnType<typeof fakeRpc>, fromBlock?: bigint) =>
  createViemChain({ chainId: 31337, rpcUrls: ["http://unused"], privateKey: KEY, epochGovernor: EG, takeoverGovernor: EG, logChunk: 30n, fromBlock, transport: rpc.transport });

describe("viem chain: ballotOrgIds", () => {
  it("finds the BallotPrepared log within the epoch's blocks, chunk by chunk", async () => {
    const rpc = fakeRpc();
    const { reader } = chainWith(rpc);
    expect(await reader.ballotOrgIds(TOKEN, 2n)).toEqual(ORGS);
    // Epoch 2 starts at block 200 (timestamp 3400); the scan stops at the chunk holding block 250.
    expect(rpc.ranges).toEqual([
      [200n, 229n],
      [230n, 259n],
    ]);
  });

  it("rejects a log that does not match the ballot commitment", async () => {
    const { reader } = chainWith(fakeRpc({ commitment: keccak256("0x01") }));
    await expect(reader.ballotOrgIds(TOKEN, 2n)).rejects.toThrow(/does not match the ballot commitment/);
  });

  it("fails when the epoch's blocks hold no ballot log", async () => {
    const rpc = fakeRpc({ logBlock: 300n });
    const { reader } = chainWith(rpc, 100n);
    await expect(reader.ballotOrgIds(TOKEN, 2n)).rejects.toThrow(/not found/);
    // Searched exactly epoch 2: blocks 200..299.
    expect(rpc.ranges.at(0)?.[0]).toBe(200n);
    expect(rpc.ranges.at(-1)?.[1]).toBe(299n);
  });
});
