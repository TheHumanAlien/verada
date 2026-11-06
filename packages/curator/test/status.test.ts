import { agentBySlug } from "@verada/sdk";
import { agentVaultAbi, causeCatalogAbi, curatorRegistryAbi, epochGovernorAbi } from "@verada/sdk/abis";
import { erc20Abi, getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { curatorStatus, toJson, vaultOf, type ChainReader } from "../src/status.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const REGISTRY = addr(0x10);
const GOVERNOR = addr(0x20);
const CATALOG = addr(0x30);
const VAULT = addr(0x40);
const USDC = addr(0x50);
const SIGNER = addr(0x60);
const ROOT = `0x${"ab".repeat(32)}` as const;
const START = 1_794_528_000n; // epochStart(next), a Thursday 00:00 UTC

const hunger = agentBySlug("hunger")!;

interface Opts {
  vault?: Address;
  version?: number;
  given?: bigint;
  cap?: bigint;
  balance?: bigint;
  paused?: boolean;
  governor?: Address;
}

/** Answers each (contract, function) pair; anything else fails the test. */
function stub(o: Opts = {}) {
  const calls: string[] = [];
  const abiOf = new Map<Address, unknown>([
    [REGISTRY, curatorRegistryAbi],
    [GOVERNOR, epochGovernorAbi],
    [CATALOG, causeCatalogAbi],
    [VAULT, agentVaultAbi],
    [USDC, erc20Abi],
  ]);
  const reader: ChainReader = {
    async readContract({ address, abi, functionName, args = [] }) {
      calls.push(`${address}.${functionName}(${args.join(",")})`);
      expect(abi).toBe(abiOf.get(address));
      const key = `${address}.${functionName}`;
      const answers: Record<string, () => unknown> = {
        [`${REGISTRY}.governor`]: () => o.governor ?? GOVERNOR,
        [`${REGISTRY}.catalog`]: () => CATALOG,
        [`${REGISTRY}.agentOf`]: () => {
          expect(args).toEqual([hunger.bit]);
          return { agentId: 7n, signer: SIGNER, vault: o.vault ?? VAULT, active: true, labelhash: ROOT, label: "hunger", description: "" };
        },
        [`${GOVERNOR}.currentEpoch`]: () => 41n,
        [`${GOVERNOR}.CURATION_GRACE`]: () => 6n * 3600n,
        [`${GOVERNOR}.epochStart`]: () => {
          expect(args).toEqual([42n]);
          return START;
        },
        [`${CATALOG}.latestVersion`]: () => o.version ?? 3,
        [`${CATALOG}.rootOf`]: () => {
          expect(args).toEqual([o.version ?? 3]);
          return ROOT;
        },
        [`${VAULT}.paused`]: () => o.paused ?? false,
        [`${VAULT}.maxGivePerEpoch`]: () => o.cap ?? 500_000_000n,
        [`${VAULT}.givenIn`]: () => {
          // Gifts count against the current epoch, not the next.
          expect(args).toEqual([41n]);
          return o.given ?? 100_000_000n;
        },
        [`${VAULT}.usdc`]: () => USDC,
        [`${USDC}.balanceOf`]: () => {
          expect(args).toEqual([VAULT]);
          return o.balance ?? 1_000_000_000n;
        },
      };
      const f = answers[key];
      if (!f) throw new Error(`unexpected read ${key}`);
      return f();
    },
    async getBlock() {
      return { timestamp: START - 7200n };
    },
  };
  return { reader, calls };
}

describe("curatorStatus", () => {
  it("reads epochs, deadlines, catalogue and vault through the registry's governor and catalogue", async () => {
    const { reader } = stub();
    const s = await curatorStatus(reader, REGISTRY, hunger);
    expect(s).toEqual({
      label: hunger.ensLabel,
      category: "hunger",
      categoryBit: hunger.bit,
      contracts: { registry: REGISTRY, governor: GOVERNOR, catalog: CATALOG },
      currentEpoch: 41n,
      nextEpoch: 42n,
      nextEpochStart: new Date(Number(START) * 1000).toISOString(),
      secondsUntilNextEpoch: 7200n,
      curationGraceEnds: new Date(Number(START + 21_600n) * 1000).toISOString(),
      catalogVersion: 3,
      catalogRoot: ROOT,
      agent: { agentId: 7n, signer: SIGNER, vault: VAULT, active: true, registered: true },
      vault: {
        address: VAULT,
        paused: false,
        usdc: USDC,
        usdcBalance: 1_000_000_000n,
        maxGivePerEpoch: 500_000_000n,
        givenThisEpoch: 100_000_000n,
        capRemaining: 400_000_000n,
        giveRemaining: 400_000_000n,
      },
    });
    const json = JSON.parse(toJson(s));
    expect(json.nextEpoch).toBe("42");
    expect(json.vault.giveRemaining).toBe("400000000");
  });

  it("limits giveRemaining by the balance, floors an overspent cap at 0, and is 0 while paused", async () => {
    expect((await curatorStatus(stub({ balance: 50n }).reader, REGISTRY, hunger)).vault).toMatchObject({ capRemaining: 400_000_000n, giveRemaining: 50n });
    expect((await curatorStatus(stub({ cap: 10n, given: 20n }).reader, REGISTRY, hunger)).vault).toMatchObject({ capRemaining: 0n, giveRemaining: 0n });
    expect((await curatorStatus(stub({ paused: true }).reader, REGISTRY, hunger)).vault).toMatchObject({ paused: true, giveRemaining: 0n });
  });

  it("does not call rootOf for catalogue version 0, and skips the vault of an unregistered agent", async () => {
    const { reader, calls } = stub({ version: 0, vault: zeroAddress });
    const s = await curatorStatus(reader, REGISTRY, hunger);
    expect(s.catalogVersion).toBe(0);
    expect(s.catalogRoot).toBeNull();
    expect(s.agent.registered).toBe(false);
    expect(s.vault).toBeNull();
    expect(calls.some((c) => c.includes("rootOf") || c.startsWith(VAULT))).toBe(false);
  });

  it("fails clearly when the registry has no governor", async () => {
    await expect(curatorStatus(stub({ governor: zeroAddress }).reader, REGISTRY, hunger)).rejects.toThrow(/no governor/);
  });
});

describe("vaultOf", () => {
  it("resolves the vault from CuratorRegistry.agentOf", async () => {
    expect(await vaultOf(stub().reader, REGISTRY, hunger.bit)).toBe(VAULT);
  });
  it("refuses an unregistered category", async () => {
    await expect(vaultOf(stub({ vault: zeroAddress }).reader, REGISTRY, hunger.bit)).rejects.toThrow(/no agent registered/);
  });
});
