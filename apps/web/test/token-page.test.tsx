import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { IndexerClient } from "@/lib/indexer";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const CONTROLLER = "0x00000000000000000000000000000000000000C0";
const VIEWER = "0x00000000000000000000000000000000000000B2";
const CAUSE_A = `0x${"0a".repeat(32)}`;
const CAUSE_B = `0x${"0b".repeat(32)}`;
const LOGO = "ab".repeat(32);

const config: AppConfig = {
  ...envDefaults(),
  indexerUrls: ["https://idx.example"],
  governorAddress: "0x00000000000000000000000000000000000000d1",
  profileRegistryAddress: "0x00000000000000000000000000000000000000d2",
  votingSchemeAddress: "0x00000000000000000000000000000000000000d3",
  takeoverGovernorAddress: "0x00000000000000000000000000000000000000d4",
  swarmGatewayUrl: "https://gw.example",
};

const fixtures: Record<string, unknown> = {
  [`/api/tokens/${TOKEN}`]: {
    address: TOKEN,
    name: "Moon Cat",
    symbol: "MCAT",
    creator: "0x00000000000000000000000000000000000000E1",
    label: "moon-cat",
    profile: {
      label: "moon-cat",
      labelhash: `0x${"11".repeat(32)}`,
      controller: CONTROLLER,
      editor: "0x0000000000000000000000000000000000000000",
      logoRef: `0x${LOGO}`,
      contenthash: "0x",
      suppressed: false,
      registeredAt: "1700000000",
      textRecords: { url: "https://mooncat.example", "com.twitter": "mooncat", description: "A cat on the moon" },
    },
    shortlist: [CAUSE_A, CAUSE_B],
    focus: { categoryMask: "4", regionMask: 1, categories: ["hunger"], regions: ["africa"] },
  },
  // The pinned causes' catalogue entries (hunger x Africa is bucket 32), so the editor can re-save them.
  [`/api/catalog/orgs/${CAUSE_A}`]: {
    root: `0x${"99".repeat(32)}`,
    org: { orgId: `0x${"a1".repeat(32)}`, causeId: CAUSE_A, ein: "100000001", name: "Alpha Fund", country: "KEN", categories: ["hunger"], regions: ["africa"] },
    entries: [{ bucket: 32, index: 0, orgId: `0x${"a1".repeat(32)}`, proof: [`0x${"98".repeat(32)}`] }],
  },
  [`/api/catalog/orgs/${CAUSE_B}`]: {
    root: `0x${"99".repeat(32)}`,
    org: { orgId: `0x${"b1".repeat(32)}`, causeId: CAUSE_B, ein: "100000002", name: "Beta Trust", country: "KEN", categories: ["hunger"], regions: ["africa"] },
    entries: [{ bucket: 32, index: 1, orgId: `0x${"b1".repeat(32)}`, proof: [`0x${"97".repeat(32)}`] }],
  },
  "/api/causes": { items: [{ causeId: CAUSE_A, name: "Alpha Fund", active: true }, { causeId: CAUSE_B, name: "Beta Trust", active: true }], nextCursor: null },
  [`/api/epochs/${TOKEN}/5`]: {
    epoch: "5",
    options: [CAUSE_A, CAUSE_B],
    prepared: true,
    poolSize: "40",
    poll: { opened: true, closed: true, isFinal: true, optionCount: 2, counts: ["10", "250"], ballotCount: 3, scheme: config.votingSchemeAddress },
    voterCount: 3,
    start: 1700000000,
    end: 1700604800,
    snapshot: 1699999999,
  },
  [`/api/takeovers/${TOKEN}`]: { items: [] },
  // Agents for hunger (in the focus, categoryMask 4 = bit 2) and homelessness (not in it).
  "/api/agents": {
    items: [
      { categoryBit: 1, category: "homelessness", name: "Homelessness", label: "homeless", ensName: "homeless.agent.varada.eth", active: true, totals: null, latest: null },
      { categoryBit: 2, category: "hunger", name: "Hunger & famine", label: "hunger", ensName: "hunger.agent.varada.eth", active: false, totals: null, latest: null },
    ],
  },
};
fixtures["/api/tokens/by-label/moon-cat"] = fixtures[`/api/tokens/${TOKEN}`];

const unavailable = new Set<string>();
const fetchMock = vi.fn(async (input: string) => {
  const path = new URL(input).pathname;
  if (unavailable.has(path)) return { ok: false, status: 503, json: async () => ({ error: "agents_unavailable" }) };
  return path in fixtures
    ? { ok: true, status: 200, json: async () => fixtures[path] }
    : { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
});
const indexer = new IndexerClient(config.indexerUrls, { fetchImpl: fetchMock as unknown as typeof fetch });
const chainRead = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === "currentEpoch") return 5n;
  if (functionName === "params") return { votingPeriod: 259200, executionWindow: 604800, cooldown: 0, minTokenAge: 604800, quorumBps: 1000, proposalThresholdBps: 100, lookback: 86400 };
  throw new Error(`unexpected public read ${functionName}`);
});
const accountRead = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "weightOf" ? 42n : false));
const account = { address: undefined as string | undefined };

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract: chainRead }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("@/lib/account-reads", () => ({ createAccountClient: (_rpc: unknown, address: string) => ({ address, readContract: accountRead }) }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: account.address }),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, error: null }),
}));

const { TokenDetail } = await import("@/components/token-detail");

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("token page", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    accountRead.mockClear();
    window.history.replaceState(null, "", `/token/?address=${TOKEN}`);
  });

  it("renders the profile, logo, ENS links and the finalized poll", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Moon Cat (MCAT)"));
    expect(screen.getByRole("img")).toHaveAttribute("src", `https://gw.example/bzz/${LOGO}/`);
    expect(screen.getByText("moon-cat.varada.eth", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "open on eth.limo" })).toHaveAttribute("href", "https://moon-cat.varada.eth.limo/");
    expect(screen.getByRole("link", { name: "https://mooncat.example" })).toBeInTheDocument();
    expect(screen.getByText("A cat on the moon")).toBeInTheDocument();
    expect(screen.getAllByText(CONTROLLER).length).toBeGreaterThan(0);

    const epoch = screen.getByRole("region", { name: "Current epoch" });
    await waitFor(() => expect(within(epoch).getByText("Tally decrypted", { exact: false })).toBeInTheDocument());
    await waitFor(() => expect(within(epoch).getByText(/Beta Trust \(250 votes, leading\)/)).toBeInTheDocument());
    expect(within(epoch).getByText(/Alpha Fund \(10 votes\)/)).toBeInTheDocument();
    expect(within(epoch).getByText(/Connect a wallet/)).toBeInTheDocument();
    // No owner panels for an anonymous viewer.
    expect(screen.queryByRole("region", { name: "Edit profile" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Shortlist" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("form", { name: "Propose takeover" })).toBeInTheDocument());
  });

  it("reads the viewer's weight privately and never sends their address to the indexer", async () => {
    account.address = VIEWER;
    wrap(<TokenDetail />);
    await waitFor(() => expect(screen.getByText(/Your weight: 42/)).toBeInTheDocument());
    expect(accountRead).toHaveBeenCalledWith(expect.objectContaining({ functionName: "weightOf", args: [TOKEN, 5n, VIEWER] }));
    for (const [url] of fetchMock.mock.calls) expect(String(url).toLowerCase()).not.toContain(VIEWER.slice(2).toLowerCase());
    expect(screen.queryByRole("region", { name: "Edit profile" })).toBeNull();
  });

  it("shows the edit and pinned-causes panels to the controller, and the cause focus", async () => {
    account.address = CONTROLLER.toLowerCase();
    wrap(<TokenDetail />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Edit profile" })).toBeInTheDocument());
    const edit = screen.getByRole("region", { name: "Edit profile" });
    expect(within(edit).getByLabelText(/Website \(url\)/)).toHaveValue("https://mooncat.example");
    expect(within(edit).getByRole("button", { name: "Set editor" })).toBeInTheDocument();
    const pinned = screen.getByRole("region", { name: "Pinned causes" });
    await waitFor(() => expect(within(pinned).getByRole("button", { name: "Unpin Alpha Fund" })).toBeInTheDocument());
    expect(within(pinned).getByRole("button", { name: "Unpin Beta Trust" })).toBeInTheDocument();
    const focus = screen.getByRole("region", { name: "Cause focus" });
    expect(focus).toHaveTextContent("Causes: Hunger & famine. Regions: Africa.");
  });

  it("lists the curator agents for the token's causes with relative links and their state", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    const curated = await screen.findByRole("region", { name: "Curated by" });
    const link = await within(curated).findByRole("link", { name: "Hunger & famine" });
    // Relative: the same build is served from many hosts and under /bzz/<hash>/.
    expect(link).toHaveAttribute("href", "./agent/hunger/");
    expect(within(curated).getByRole("listitem")).toHaveTextContent("Hunger & famine (hunger.agent.varada.eth): inactive");
    expect(within(curated).queryByText(/Homelessness/)).toBeNull();
  });

  it("keeps the page working when the indexer has no agents", async () => {
    account.address = undefined;
    unavailable.add("/api/agents");
    try {
      wrap(<TokenDetail />);
      const curated = await screen.findByRole("region", { name: "Curated by" });
      await waitFor(() => expect(within(curated).getByRole("note")).toHaveTextContent(/unavailable/));
      expect(within(curated).queryByRole("link")).toBeNull();
      expect(screen.getByRole("region", { name: "Cause focus" })).toBeInTheDocument();
    } finally {
      unavailable.delete("/api/agents");
    }
  });
});

describe("token route by label", () => {
  it("resolves token/?label= (the plain-DNS redirect target) through the indexer fallback", async () => {
    account.address = undefined;
    window.history.replaceState(null, "", "/token/?label=moon-cat");
    wrap(<TokenDetail />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Moon Cat (MCAT)"));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/tokens/by-label/moon-cat"))).toBe(true);
  });
});

describe("takeover panel", () => {
  it("shows the holding period, quorum as a share of circulating weight, and Superseded history", async () => {
    account.address = undefined;
    window.history.replaceState(null, "", `/token/?address=${TOKEN}`);
    const saved = fixtures[`/api/takeovers/${TOKEN}`];
    fixtures[`/api/takeovers/${TOKEN}`] = {
      items: [
        { proposalId: "3", token: TOKEN, proposer: CONTROLLER, newController: VIEWER, start: 1700000000, end: 1700259200, snapshot: 1699999999, lookbackSnapshot: 1699913599, quorumWeight: "100", circulatingWeight: "1000", forWeight: "0", againstWeight: "0", state: "Active" },
        { proposalId: "2", token: TOKEN, proposer: CONTROLLER, newController: VIEWER, quorumWeight: "50", state: 8 },
      ],
    };
    try {
      wrap(<TokenDetail />);
      const panel = await screen.findByRole("region", { name: "Takeover" });
      await waitFor(() => expect(within(panel).getByText(/Holding period 1 day:/)).toBeInTheDocument());
      expect(within(panel).getByText(/100 of 1000 circulating \(10\.00%\)/)).toBeInTheDocument();
      expect(within(panel).getByText(/#2 Superseded \(a newer proposal/)).toBeInTheDocument();
      expect(within(panel).getByRole("heading", { name: /Proposal #3: Voting open/ })).toBeInTheDocument();
    } finally {
      fixtures[`/api/takeovers/${TOKEN}`] = saved;
    }
  });

  it("formats shares and state labels", async () => {
    const { shareOf, takeoverStateLabel } = await import("@/components/takeover-panel");
    const { takeoverStateName } = await import("@/lib/indexer");
    expect(shareOf("1", "3")).toBe("33.33%");
    expect(shareOf("1", undefined)).toBeNull();
    expect(shareOf("1", "0")).toBeNull();
    expect(takeoverStateName(8)).toBe("Superseded");
    expect(takeoverStateName("superseded")).toBe("Superseded");
    expect(takeoverStateLabel("Superseded")).toMatch(/newer proposal/);
  });
});
