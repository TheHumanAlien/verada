import { describe, expect, it } from "vitest";
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { epochGovernorAbi } from "../src/abis/index.js";
import { ballotCall, createBallotReader, planBallotOpening, type BallotReader } from "../src/ballot-prep.js";

const EG = "0x00000000000000000000000000000000000000e1" as Address;
const T = "0x00000000000000000000000000000000000000a1" as Address;
const ORG = `0x${"11".repeat(32)}` as Hex;

describe("ballotCall", () => {
  it("encodes each opening on the epoch governor", () => {
    const open = ballotCall({ kind: "openEpoch", token: T, epoch: 3n }, EG);
    expect(open.address).toBe(EG);
    expect(open.functionName).toBe("openEpoch");
    const skip = ballotCall({ kind: "requestCurationSkip", token: T, epoch: 3n }, EG);
    expect(skip).toMatchObject({ functionName: "requestCurationSkip", args: [T, 3n] });
    expect(() => encodeFunctionData(open as never)).not.toThrow();
    const prep = ballotCall({ kind: "prepareBallot", token: T, epoch: 3n, draws: [{ orgId: ORG, proof: [] }] }, EG);
    expect(prep.args).toEqual([T, 3n, [{ orgId: ORG, proof: [] }]]);
    expect(() => encodeFunctionData(prep as never)).not.toThrow();
    const cur = ballotCall(
      { kind: "prepareCuratedBallot", token: T, epoch: 3n, curated: [{ catalogIndex: 1, pickOrgId: ORG, pickProof: [], entryOrgId: ORG, entryProof: [] }], draws: [] },
      EG,
    );
    expect(cur.functionName).toBe("prepareCuratedBallot");
    expect(() => encodeFunctionData(cur as never)).not.toThrow();
  });
});

describe("planBallotOpening", () => {
  const base: BallotReader = {
    isPrepared: async () => false,
    poolOf: async () => ({ version: 0, poolSize: 0n }),
    pinned: async () => [],
    ballotSize: async () => 32,
    focusOf: async () => ({ categoryMask: 0n, regionMask: 0 }),
    bucketSizes: async () => [],
    catalogRoot: async () => ORG,
    isBlocked: async () => false,
  };
  const entries = { entries: async () => ({ root: ORG, items: [] }) };

  it("is terminal once prepared, and opens directly without a catalogue pool", async () => {
    expect(await planBallotOpening({ reader: { ...base, isPrepared: async () => true }, entries }, T, 1n)).toEqual({
      type: "none",
      reason: "ballot prepared",
      terminal: true,
    });
    expect(await planBallotOpening({ reader: base, entries }, T, 1n)).toEqual({ type: "send", action: { kind: "openEpoch", token: T, epoch: 1n } });
  });
});

describe("createBallotReader", () => {
  it("reads the governor and its linked contracts through one client", async () => {
    const calls: string[] = [];
    const client = {
      async readContract(a: { address: Address; functionName: string; args?: readonly unknown[] }) {
        calls.push(`${a.address}:${a.functionName}`);
        switch (a.functionName) {
          case "isPrepared":
            return true;
          case "poolOf":
            return [2, 40n];
          case "ballotSize":
            return 32n;
          case "profileRegistry":
            return "0x00000000000000000000000000000000000000f1";
          case "catalog":
          case "registry":
            return "0x00000000000000000000000000000000000000f2";
          case "focusOf":
            return [4n, 1];
          case "curationSkipAt":
            return 22_600n;
          case "curators":
            return zeroAddress;
          default:
            throw new Error(`unexpected ${a.functionName}`);
        }
      },
      async getBlock() {
        return { timestamp: 2000n };
      },
    };
    const r = createBallotReader(client as never, EG);
    expect(await r.isPrepared(T, 1n)).toBe(true);
    expect(await r.poolOf(T, 1n)).toEqual({ version: 2, poolSize: 40n });
    expect(await r.ballotSize()).toBe(32);
    expect(await r.focusOf(T)).toEqual({ categoryMask: 4n, regionMask: 1 });
    expect(await r.curationSkipAt!(T, 1n)).toBe(22_600n);
    expect(await r.now!()).toBe(2000n);
    expect(await r.curationsFor!(1n, 2, [3])).toEqual([]);
    // Links are read once.
    expect(calls.filter((c) => c.endsWith(":profileRegistry"))).toHaveLength(1);
    expect(epochGovernorAbi.some((x) => x.type === "function" && x.name === "openEpoch")).toBe(true);
  });
});
