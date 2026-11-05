import { describe, expect, it } from "vitest";
import {
  AGENT_CATEGORIES,
  BUCKET_COUNT,
  agentByLabel,
  agentName,
  bucketId,
  categoryMaskOf,
  causeIdOfOrg,
  curatedQuotas,
  parseAgentName,
  parseGatewayHostname,
  planBallot,
  regionMaskOf,
} from "../src/index.js";

describe("agent names", () => {
  it("has one agent per cause except other, with unique short labels", () => {
    expect(AGENT_CATEGORIES).toHaveLength(20);
    expect(AGENT_CATEGORIES.some((c) => c.slug === "other")).toBe(false);
    expect(new Set(AGENT_CATEGORIES.map((c) => c.ensLabel)).size).toBe(20);
    expect(agentByLabel("homeless")?.slug).toBe("homelessness");
    expect(agentName("homeless")).toBe("homeless.agent.varada.eth");
    expect(parseAgentName("Homeless.agent.varada.eth.")).toBe("homeless");
    expect(parseAgentName("homeless.varada.eth")).toBeNull();
    expect(parseAgentName("nope.agent.varada.eth")).toBeNull();
    expect(() => agentName("other")).toThrow();
  });
  it("parses agent gateway hostnames", () => {
    expect(parseGatewayHostname("homeless.agent.varada.eth.limo")).toMatchObject({ agent: "homeless", label: null });
    expect(parseGatewayHostname("agent.varada.eth.limo")).toMatchObject({ agent: "", label: null });
    expect(parseGatewayHostname("pepe.varada.eth.limo")).toMatchObject({ label: "pepe" });
    expect(parseGatewayHostname("pepe.varada.eth.limo")?.agent).toBeUndefined();
  });
});

describe("curatedQuotas", () => {
  it("splits slots by weight, caps at the pick count, and hands out leftovers in bucket order", () => {
    expect(curatedQuotas(10, [{ bucket: 1, count: 32, weight: 5000 }, { bucket: 2, count: 32, weight: 5000 }])).toEqual([5, 5]);
    // floor(32*1/3)=10 each, 2 leftover go to the first buckets.
    expect(curatedQuotas(32, [{ bucket: 1, count: 32, weight: 1 }, { bucket: 2, count: 32, weight: 1 }, { bucket: 3, count: 32, weight: 1 }])).toEqual([11, 11, 10]);
    // Caps push leftovers to buckets with picks to spare.
    expect(curatedQuotas(20, [{ bucket: 1, count: 2, weight: 9000 }, { bucket: 2, count: 32, weight: 1000 }])).toEqual([2, 18]);
    // Not enough picks: everything is taken and the rest goes to rotation.
    expect(curatedQuotas(32, [{ bucket: 1, count: 3, weight: 1 }, { bucket: 2, count: 4, weight: 1 }])).toEqual([3, 4]);
    // No weight or no picks: nothing.
    expect(curatedQuotas(32, [{ bucket: 1, count: 0, weight: 5 }, { bucket: 2, count: 5, weight: 0 }])).toEqual([0, 0]);
    expect(curatedQuotas(0, [{ bucket: 1, count: 5, weight: 5 }])).toEqual([0]);
  });
  it("never assigns more than the slots or the counts", () => {
    for (let seed = 1; seed < 200; seed++) {
      const n = (seed % 7) + 1;
      const cs = Array.from({ length: n }, (_, i) => ({ bucket: i, count: (seed * (i + 3)) % 33, weight: (seed * 7919 * (i + 1)) % 10_001 }));
      const slots = seed % 33;
      const q = curatedQuotas(slots, cs);
      expect(q.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(slots);
      q.forEach((x, i) => expect(x).toBeLessThanOrEqual(cs[i]!.weight > 0 ? cs[i]!.count : 0));
      const capacity = cs.reduce((a, c) => a + (c.weight > 0 ? c.count : 0), 0);
      if (cs.some((c) => c.weight > 0 && c.count > 0)) expect(q.reduce((a, b) => a + b, 0)).toBe(Math.min(slots, capacity));
    }
  });
});

describe("planBallot", () => {
  const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
  const HA = bucketId(2, 0);
  const HAS = bucketId(2, 1);
  sizes[HA] = 40;
  sizes[HAS] = 10;
  const org = (b: number, i: number) => `0x${b.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}` as `0x${string}`;
  const base = {
    token: "0x00000000000000000000000000000000000000aa" as const,
    epoch: 5n,
    version: 1,
    bucketSizes: sizes,
    categoryMask: categoryMaskOf(["hunger"]),
    regionMask: regionMaskOf(["africa", "asia"]),
    pinned: [] as `0x${string}`[],
    ballotSize: 10,
  };
  const deps = {
    entryAt: async (b: number, i: number) => org(b, i),
    // The agent picks catalogue indices in reverse; rank 2 of Africa claims a wrong org.
    pickAt: async (b: number, r: number) => ({ catalogIndex: sizes[b]! - 1 - r, orgId: b === HA && r === 2 ? org(b, 999) : org(b, sizes[b]! - 1 - r) }),
    isBlocked: async () => false,
  };

  it("takes curated picks by quota, skips a provably wrong pick, then rotates", async () => {
    const r = await planBallot({ ...base, curations: [{ bucket: HA, count: 32, weight: 6000 }, { bucket: HAS, count: 10, weight: 4000 }] }, deps);
    expect(r.curated.map((c) => `${c.bucket}:${c.rank}`)).toEqual([...[0, 1, 2, 3, 4, 5].map((k) => `${HA}:${k}`), ...[0, 1, 2, 3].map((k) => `${HAS}:${k}`)]);
    expect(r.curated[2]!.entryOrgId).toBe(org(HA, 37));
    expect(r.options).toHaveLength(10);
    expect(r.options).not.toContain(causeIdOfOrg(org(HA, 999)).toLowerCase());
    // The skipped pick left one slot to rotation.
    expect(r.draws.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to rotation only when there are no curations", async () => {
    const r = await planBallot({ ...base, curations: [] }, deps);
    expect(r.curated).toEqual([]);
    expect(r.options).toHaveLength(10);
  });
});
