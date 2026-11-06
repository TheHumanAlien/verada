import { describe, expect, it, vi } from "vitest";
import { AGENT_CATEGORIES, REGIONS } from "@verada/sdk";

// The pages only pick params and hand them to the client component; keep it out of this test.
vi.mock("@/components/agent-detail", () => ({ AgentDetail: () => null }));

const labelPage = await import("@/app/agent/[label]/page");
const regionPage = await import("@/app/agent/[label]/[region]/page");

describe("agent routes", () => {
  it("export one page per agent and one per agent x region, nothing else", () => {
    expect(labelPage.dynamicParams).toBe(false);
    expect(regionPage.dynamicParams).toBe(false);
    const labels = labelPage.generateStaticParams();
    expect(labels).toHaveLength(20);
    expect(labels.map((p) => p.label)).toEqual(AGENT_CATEGORIES.map((c) => c.ensLabel));
    const pairs = regionPage.generateStaticParams();
    expect(pairs).toHaveLength(20 * REGIONS.length);
    expect(pairs).toContainEqual({ label: "homeless", region: "middle-east" });
  });

  it("render the agent page for known params with the right root", async () => {
    const el = await labelPage.default({ params: Promise.resolve({ label: "homeless" }) });
    expect(el.props).toEqual({ label: "homeless", root: "../../" });
    const r = await regionPage.default({ params: Promise.resolve({ label: "homeless", region: "africa" }) });
    expect(r.props).toEqual({ label: "homeless", region: "africa", root: "../../../" });
  });

  it("use the not-found page for unknown labels and regions", async () => {
    await expect(labelPage.default({ params: Promise.resolve({ label: "nope" }) })).rejects.toThrow();
    await expect(regionPage.default({ params: Promise.resolve({ label: "homeless", region: "mars" }) })).rejects.toThrow();
    await expect(regionPage.default({ params: Promise.resolve({ label: "nope", region: "africa" }) })).rejects.toThrow();
  });
});
