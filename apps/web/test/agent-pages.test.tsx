import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { toAgentDetail, toAgentReport, toAgentSummary, type AgentDetail as AgentInfo, type AgentReport, type AgentSummary } from "@/lib/agents";

const VAULT = "0x00000000000000000000000000000000000000A9";
const CREDITED = "0x00000000000000000000000000000000000000C1";
const ANON = "0x00000000000000000000000000000000000000D2";
const ORG_A = `0x${"a1".repeat(32)}`;
const ORG_B = `0x${"b1".repeat(32)}`;
const ORG_C = `0x${"c1".repeat(32)}`;

const REGISTRY = "0x00000000000000000000000000000000000000B7";
const baseConfig: AppConfig = { ...envDefaults(), indexerUrls: ["https://idx.example"], curatorRegistryAddress: REGISTRY };
let config: AppConfig = baseConfig;

const agentRow = {
  categoryBit: 1,
  category: "homelessness",
  name: "Homelessness",
  label: "homeless",
  ensName: "homeless.agent.varada.eth",
  agentId: "17",
  signer: "0x00000000000000000000000000000000000000E1",
  vault: VAULT,
  active: true,
  description: "Ranks homelessness charities weekly.",
  walletLinked: true,
  totals: { donated: "1234560000", donations: 3, given: "500000000", gifts: 1 },
};

function detail(over: Record<string, unknown> = {}): AgentInfo {
  return toAgentDetail({
    ...agentRow,
    reports: [
      { epoch: "12", reportRef: `0x${"12".repeat(32)}`, catalogVersion: 3, submittedAt: 1700000000 },
      { epoch: "11", reportRef: `0x${"11".repeat(32)}`, catalogVersion: 3, submittedAt: 1699395200 },
    ],
    latestCurations: [],
    donors: [
      { donor: CREDITED, amount: "250000000", credit: true, timestamp: 1700000100, txHash: `0x${"f1".repeat(32)}` },
      // Must never be shown: not credited on chain.
      { donor: ANON, amount: "90000000", credit: false, timestamp: 1700000200, txHash: `0x${"f2".repeat(32)}` },
    ],
    gifts: [{ id: "g1", epoch: "11", regionBit: 0, orgId: ORG_A, org: "0x00000000000000000000000000000000000000F0", amount: "500000000", timestamp: 1700000300, txHash: `0x${"f3".repeat(32)}` }],
    ...over,
  })!;
}

function report(epoch: string, over: Record<string, unknown> = {}): AgentReport {
  return toAgentReport({
    agent: agentRow,
    epoch,
    reportRef: `0x${"12".repeat(32)}`,
    catalogVersion: 3,
    title: `Week ${epoch}: winter shelters`,
    intro: "Cold snaps are **early** this year. <script>alert(1)</script>",
    generatedAt: "2026-11-01T00:00:00Z",
    regions: [
      {
        region: "europe",
        regionBit: 2,
        bucket: 2,
        picksRoot: `0x${"e2".repeat(32)}`,
        verified: false,
        weight: 2500,
        summary: "Europe summary.",
        events: [],
        picks: [{ rank: 0, orgId: ORG_C, catalogIndex: 4, name: "Gamma Shelter", score: 70, reasons: "Night beds.", sources: [] }],
        newsletter: "Europe newsletter.",
      },
      {
        region: "africa",
        regionBit: 0,
        bucket: 0,
        picksRoot: `0x${"a0".repeat(32)}`,
        verified: true,
        weight: 7500,
        summary: "Floods displaced families in Lagos.",
        events: [
          { title: "Lagos floods", url: "https://news.example/lagos", date: "2026-10-30", summary: "Thousands displaced." },
          { title: "Bad link", url: "javascript:alert(1)", date: "2026-10-29", summary: "Should not be a link." },
        ],
        picks: [
          { rank: 1, orgId: ORG_B, catalogIndex: 9, name: "Beta Housing", score: 81, reasons: "Builds homes.", sources: ["data:text/html,<b>x</b>"] },
          { rank: 0, orgId: ORG_A, catalogIndex: 2, name: "Alpha Shelter", score: 92, reasons: "Emergency beds <img src=x onerror=alert(1)>", sources: ["https://alpha.example/report", "javascript:alert(2)"] },
        ],
        newsletter: "# Africa this week\n\n- Read [the brief](https://brief.example/a)\n- [evil](javascript:alert(3))\n\n<iframe src=\"https://evil.example\"></iframe>",
      },
    ],
    ...over,
  })!;
}

const getAgent = vi.fn<(c: unknown, label: string) => Promise<AgentInfo | null>>();
const getAgentReport = vi.fn<(c: unknown, label: string, epoch: string | number | bigint) => Promise<AgentReport | null>>();
const listAgents = vi.fn<(c: unknown) => Promise<AgentSummary[]>>();

vi.mock("@/lib/agents", async (orig) => ({
  ...(await orig<typeof import("@/lib/agents")>()),
  getAgent: (c: unknown, l: string) => getAgent(c, l),
  getAgentReport: (c: unknown, l: string, e: string | number | bigint) => getAgentReport(c, l, e),
  listAgents: (c: unknown) => listAgents(c),
}));

/** What `CuratorRegistry.agentOf` returns on chain; tests change it per case. */
const registryAgent = { vault: VAULT as string, active: true };
async function defaultChainRead({ functionName, address }: { functionName: string; address: string; args?: unknown[] }): Promise<unknown> {
  if (functionName === "agentOf" && address === REGISTRY) return { agentId: 17n, signer: agentRow.signer, ...registryAgent };
  if (functionName === "paused" && address === registryAgent.vault) return false;
  throw new Error(`unexpected public read ${functionName}`);
}
const chainRead = vi.fn(defaultChainRead);
async function defaultAccountRead({ functionName }: { functionName: string }): Promise<bigint> {
  if (functionName === "allowance") return 0n;
  if (functionName === "balanceOf") return 100_000_000n;
  throw new Error(`unexpected account read ${functionName}`);
}
const accountRead = vi.fn(defaultAccountRead);
let txCount = 0;
const writeContractAsync = vi.fn<(req: unknown) => Promise<string>>(async () => `0x${(++txCount).toString(16).padStart(64, "0")}`);
const account = { address: undefined as string | undefined };
/** Receipts by hash (stable objects, like wagmi's cache). With `autoConfirm`, every sent tx confirms at once. */
const chainTxs = { autoConfirm: false, receipts: new Map<string, { status: "success"; blockNumber: bigint; transactionHash: string }>() };
function receiptOf(hash: string | undefined) {
  if (!hash) return undefined;
  if (chainTxs.autoConfirm && !chainTxs.receipts.has(hash)) chainTxs.receipts.set(hash, { status: "success", blockNumber: 5n, transactionHash: hash });
  return chainTxs.receipts.get(hash);
}

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer: { get: vi.fn() }, chain: () => ({ readContract: chainRead }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("@/lib/account-reads", () => ({ createAccountClient: (_rpc: unknown, address: string) => ({ address, readContract: accountRead }) }));
vi.mock("wagmi", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useAccount: () => ({ address: account.address }),
    // Like wagmi: `data` is the hash of the last write once the wallet returns it.
    useWriteContract: () => {
      const [hash, setHash] = useState<string>();
      const send = useCallback(async (req: unknown) => {
        const h = await writeContractAsync(req);
        setHash(h);
        return h;
      }, []);
      return { writeContractAsync: send, data: hash, isPending: false, error: null, reset: () => setHash(undefined) };
    },
    useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({ data: receiptOf(hash), error: null }),
  };
});

const { AgentDetail } = await import("@/components/agent-detail");
const { AgentIndex } = await import("@/components/agent-index");

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("agent page", () => {
  beforeEach(() => {
    account.address = undefined;
    getAgent.mockReset().mockImplementation(async () => detail());
    getAgentReport.mockReset().mockImplementation(async (_c, _l, e) => report(String(e)));
    listAgents.mockReset();
    writeContractAsync.mockClear();
    accountRead.mockReset().mockImplementation(defaultAccountRead);
    chainRead.mockReset().mockImplementation(defaultChainRead);
    config = baseConfig;
    Object.assign(registryAgent, { vault: VAULT, active: true });
    chainTxs.autoConfirm = false;
    chainTxs.receipts.clear();
  });

  it("shows identity, totals and the latest report with ranked picks", async () => {
    wrap(<AgentDetail label="homeless" root="../../" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Homelessness");
    await waitFor(() => expect(screen.getByText("ERC-8004 #17")).toBeInTheDocument());
    expect(screen.getByText("homeless.agent.varada.eth", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(VAULT)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("1,234.56 USDC in 3 donations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All agents" })).toHaveAttribute("href", "../../agent/");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Week 12: winter shelters" })).toBeInTheDocument());
    expect(getAgentReport).toHaveBeenCalledWith(expect.anything(), "homeless", "12");
    // Africa sorts before Europe (SDK region order) and is the first tab.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Africa (2)", "Europe (1)"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    const picks = screen.getByRole("list", { name: "Africa ranked picks" });
    const items = within(picks).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("#1 Alpha Shelter");
    expect(items[0]).toHaveTextContent("score 92/100");
    expect(items[1]).toHaveTextContent("#2 Beta Housing");
    expect(screen.getByText("Verified on-chain")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the Africa page" })).toHaveAttribute("href", "../../agent/homeless/africa/");

    fireEvent.click(tabs[1]!);
    expect(screen.getByRole("list", { name: "Europe ranked picks" })).toHaveTextContent("Gamma Shelter");
    expect(screen.getByText("Not verified on-chain")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Africa ranked picks" })).toBeNull();
  });

  it("renders untrusted report text, newsletter, sources and events safely", async () => {
    const { container } = wrap(<AgentDetail label="homeless" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Africa this week" })).toBeInTheDocument());
    // No raw HTML from the report reaches the DOM.
    expect(container.querySelector("script, iframe, img")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText("early").tagName).toBe("STRONG");
    expect(screen.getByText(/Emergency beds <img/)).toBeInTheDocument();

    const brief = screen.getByRole("link", { name: "the brief" });
    expect(brief).toHaveAttribute("href", "https://brief.example/a");
    expect(brief).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(brief).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "evil" })).toBeNull();

    const source = screen.getByRole("link", { name: "alpha.example" });
    expect(source).toHaveAttribute("href", "https://alpha.example/report");
    expect(source).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(screen.getByRole("link", { name: "Lagos floods" })).toHaveAttribute("href", "https://news.example/lagos");
    expect(screen.queryByRole("link", { name: "Bad link" })).toBeNull();
    expect(screen.getByText("Bad link")).toBeInTheDocument();
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href")).not.toMatch(/^(javascript|data):/i);
  });

  it("lists credited donors only and never shows an anonymous donor's address", async () => {
    wrap(<AgentDetail label="homeless" />);
    const donors = await screen.findByRole("region", { name: "Credited donors" });
    expect(within(donors).getByText(new RegExp(CREDITED))).toHaveTextContent("250 USDC");
    expect(document.body.textContent).not.toContain(ANON);
    expect(document.body.textContent?.toLowerCase()).not.toContain(ANON.slice(2).toLowerCase());
    expect(within(screen.getByRole("region", { name: "Recent gifts" })).getByText(/500 USDC to 0x0000/)).toBeInTheDocument();
  });

  it("loads an archived epoch's report", async () => {
    wrap(<AgentDetail label="homeless" />);
    const archive = await screen.findByRole("region", { name: "Report archive" });
    const latest = within(archive).getByRole("button", { name: "Epoch 12" });
    expect(latest).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(archive).getByRole("button", { name: "Epoch 11" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Week 11: winter shelters" })).toBeInTheDocument());
    expect(getAgentReport).toHaveBeenLastCalledWith(expect.anything(), "homeless", "11");
    expect(screen.getByRole("heading", { name: "Report for epoch 11" })).toBeInTheDocument();
  });

  it("region page shows only that region's picks", async () => {
    wrap(<AgentDetail label="homeless" region="europe" root="../../../" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Homelessness: Europe");
    await waitFor(() => expect(screen.getByRole("list", { name: "Europe ranked picks" })).toBeInTheDocument());
    expect(screen.queryByText("Alpha Shelter")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    const regions = screen.getByRole("navigation", { name: "Regions" });
    expect(within(regions).getByText("Europe")).toHaveAttribute("aria-current", "page");
    expect(within(regions).getByRole("link", { name: "All regions" })).toHaveAttribute("href", "../../../agent/homeless/");
    expect(within(regions).getByRole("link", { name: "Africa" })).toHaveAttribute("href", "../../../agent/homeless/africa/");
  });

  it("region page says when the report has nothing for the region", async () => {
    wrap(<AgentDetail label="homeless" region="oceania" />);
    await waitFor(() => expect(screen.getByText("The agent published nothing for Oceania this week.")).toBeInTheDocument());
  });

  it("region tabs follow the WAI-ARIA keyboard pattern", async () => {
    wrap(<AgentDetail label="homeless" />);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    const [africa, europe] = screen.getAllByRole("tab") as [HTMLElement, HTMLElement];
    // Roving tabIndex: only the selected tab is in the tab order.
    expect(africa).toHaveAttribute("tabindex", "0");
    expect(europe).toHaveAttribute("tabindex", "-1");

    africa.focus();
    fireEvent.keyDown(africa, { key: "ArrowRight" });
    expect(europe).toHaveFocus();
    expect(europe).toHaveAttribute("aria-selected", "true");
    expect(europe).toHaveAttribute("tabindex", "0");
    expect(africa).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "region-tab-europe");

    fireEvent.keyDown(europe, { key: "ArrowRight" });
    expect(africa).toHaveFocus();
    expect(africa).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(africa, { key: "ArrowLeft" });
    expect(europe).toHaveFocus();
    fireEvent.keyDown(europe, { key: "Home" });
    expect(africa).toHaveFocus();
    expect(africa).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(africa, { key: "End" });
    expect(europe).toHaveFocus();
    expect(europe).toHaveAttribute("aria-selected", "true");
    // Other keys do nothing.
    fireEvent.keyDown(europe, { key: "a" });
    expect(europe).toHaveAttribute("aria-selected", "true");
  });

  it("renders newsletter headings below the Newsletter heading", async () => {
    wrap(<AgentDetail label="homeless" />);
    const heading = await screen.findByRole("heading", { name: "Africa this week" });
    const newsletter = screen.getByRole("heading", { name: "Newsletter" });
    expect(newsletter.tagName).toBe("H4");
    expect(heading.tagName).toBe("H5");
  });

  it("nests intro headings directly under the nearest rendered heading", async () => {
    getAgentReport.mockImplementation(async (_c, _l, e) => report(String(e), { intro: "# Overview\n\nText." }));
    const titled = wrap(<AgentDetail label="homeless" />);
    expect((await screen.findByRole("heading", { name: "Week 12: winter shelters" })).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Overview" }).tagName).toBe("H4");
    titled.unmount();

    // No title: the section's h2 is the nearest heading, so the intro's top heading is an h3.
    getAgentReport.mockImplementation(async (_c, _l, e) => report(String(e), { title: "", intro: "# Overview\n\n## Detail" }));
    wrap(<AgentDetail label="homeless" />);
    const overview = await screen.findByRole("heading", { name: "Overview" });
    expect(screen.getByRole("heading", { name: "Report for epoch 12" }).tagName).toBe("H2");
    expect(screen.queryByRole("heading", { level: 3, name: /Week 12/ })).toBeNull();
    expect(overview.tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Detail" }).tagName).toBe("H4");
  });

  it("handles unknown, unregistered and failing agents", async () => {
    wrap(<AgentDetail label="nope" />);
    expect(screen.getByRole("alert")).toHaveTextContent("No curator agent has the name nope.");
    expect(getAgent).not.toHaveBeenCalled();

    getAgent.mockImplementation(async () => null);
    wrap(<AgentDetail label="hunger" />);
    await waitFor(() => expect(screen.getByText("This agent is not registered yet.")).toBeInTheDocument());

    getAgent.mockImplementation(async () => {
      throw new Error("indexer down");
    });
    wrap(<AgentDetail label="water" />);
    await waitFor(() => expect(screen.getByText("Could not load agent: indexer down")).toBeInTheDocument());
  });

  it("says when no report is published", async () => {
    getAgent.mockImplementation(async () => detail({ reports: [] }));
    wrap(<AgentDetail label="homeless" />);
    await waitFor(() => expect(screen.getByText("No report published yet.")).toBeInTheDocument());
    expect(getAgentReport).not.toHaveBeenCalled();
  });
});

describe("donate panel", () => {
  beforeEach(() => {
    account.address = undefined;
    getAgent.mockReset().mockImplementation(async () => detail());
    getAgentReport.mockReset().mockImplementation(async (_c, _l, e) => report(String(e)));
    writeContractAsync.mockClear();
    accountRead.mockReset().mockImplementation(defaultAccountRead);
    chainRead.mockReset().mockImplementation(defaultChainRead);
    config = baseConfig;
    Object.assign(registryAgent, { vault: VAULT, active: true });
    chainTxs.autoConfirm = false;
    chainTxs.receipts.clear();
  });

  async function panel() {
    const p = await screen.findByRole("region", { name: "Donate" });
    return {
      p,
      amount: within(p).getByLabelText("Amount (USDC)"),
      credit: within(p).getByRole("checkbox", { name: /Credit me publicly/ }),
      submit: within(p).getByRole("button"),
    };
  }

  it("is disabled until a wallet connects, and credit defaults to off", async () => {
    wrap(<AgentDetail label="homeless" />);
    const { p, amount, credit, submit } = await panel();
    expect(submit).toBeDisabled();
    expect(amount).toBeDisabled();
    expect(credit).not.toBeChecked();
    expect(await within(p).findByText("Connect a wallet to donate.")).toBeInTheDocument();
    // The vault is read from the registry by the agent's SDK category bit, through the public chain client.
    expect(chainRead).toHaveBeenCalledWith(expect.objectContaining({ address: REGISTRY, functionName: "agentOf", args: [1] }));
    expect(within(p).getByText(/anonymous on this site/)).toHaveTextContent("still visible on chain");
  });

  it("is disabled while the agent is paused", async () => {
    account.address = CREDITED;
    getAgent.mockImplementation(async () => detail({ active: false }));
    registryAgent.active = false;
    wrap(<AgentDetail label="homeless" />);
    const { p, submit } = await panel();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(await within(p).findByText(/is paused, so donations are closed/)).toBeInTheDocument();
  });

  it("is disabled while the vault is paused on chain", async () => {
    account.address = CREDITED;
    chainRead.mockImplementation(async (req) => (req.functionName === "paused" ? true : defaultChainRead(req)));
    wrap(<AgentDetail label="homeless" />);
    const { p } = await panel();
    await waitFor(() => expect(within(p).getByText(/is paused, so donations are closed/)).toBeInTheDocument());
    expect(within(p).getByRole("button")).toBeDisabled();
  });

  it("validates the amount and the balance before sending anything", async () => {
    account.address = CREDITED;
    wrap(<AgentDetail label="homeless" />);
    const { p, amount, submit } = await panel();
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(within(p).getByRole("alert")).toHaveTextContent("Enter an amount");
    fireEvent.change(amount, { target: { value: "1.1234567" } });
    fireEvent.click(submit);
    expect(within(p).getByRole("alert")).toHaveTextContent("at most 6 decimal places");
    fireEvent.change(amount, { target: { value: "-5" } });
    fireEvent.click(submit);
    expect(within(p).getByRole("alert")).toHaveTextContent("Enter a number");
    fireEvent.change(amount, { target: { value: "0" } });
    fireEvent.click(submit);
    expect(within(p).getByRole("alert")).toHaveTextContent("more than 0");
    fireEvent.change(amount, { target: { value: "150" } });
    fireEvent.click(submit);
    expect(within(p).getByRole("alert")).toHaveTextContent("less than 150 USDC");
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("approves first when the allowance is short", async () => {
    account.address = CREDITED;
    wrap(<AgentDetail label="homeless" />);
    const { p, amount } = await panel();
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    fireEvent.change(amount, { target: { value: "25.5" } });
    fireEvent.click(within(p).getByRole("button", { name: "Approve 25.5 USDC" }));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({ functionName: "approve", args: [VAULT, 25_500_000n], chainId: config.chainId });
    // The donor's reads go through their own isolated client, never the indexer.
    expect(accountRead).toHaveBeenCalledWith(expect.objectContaining({ functionName: "allowance", args: [CREDITED, VAULT] }));
  });

  it("donates with the credit choice once the allowance covers the amount", async () => {
    account.address = CREDITED;
    chainTxs.autoConfirm = true;
    accountRead.mockImplementation(async ({ functionName }) => (functionName === "allowance" ? 25_500_000n : 100_000_000n));
    wrap(<AgentDetail label="homeless" />);
    const { p, amount, credit } = await panel();
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    fireEvent.change(amount, { target: { value: "25.5" } });
    const donate = within(p).getByRole("button", { name: "Donate 25.5 USDC" });
    fireEvent.click(donate);
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({ functionName: "donate", address: VAULT, args: [25_500_000n, false] });
    await within(p).findByText("Thank you. Your donation is anonymous on this site.");
    await waitFor(() => expect(donate).toBeEnabled());

    fireEvent.click(credit);
    expect(credit).toBeChecked();
    fireEvent.click(donate);
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    expect(writeContractAsync.mock.calls[1]![0]).toMatchObject({ functionName: "donate", args: [25_500_000n, true] });
  });

  it("stays disabled, and reads nothing, when no curator registry is configured", async () => {
    account.address = CREDITED;
    config = { ...baseConfig, curatorRegistryAddress: undefined };
    wrap(<AgentDetail label="homeless" />);
    const { p, amount, submit } = await panel();
    expect(within(p).getByRole("note")).toHaveTextContent("no curator registry is configured");
    expect(submit).toBeDisabled();
    expect(amount).toBeDisabled();
    expect(chainRead).not.toHaveBeenCalled();
    expect(accountRead).not.toHaveBeenCalled();
  });

  it("blocks the form when the indexer's vault is not the one registered on chain", async () => {
    account.address = CREDITED;
    const other = "0x00000000000000000000000000000000000000Ee";
    registryAgent.vault = other;
    wrap(<AgentDetail label="homeless" />);
    const { p, submit } = await panel();
    const alert = await within(p).findByRole("alert");
    expect(alert).toHaveTextContent("is not the one registered on chain");
    expect(alert).toHaveTextContent(VAULT);
    expect(submit).toBeDisabled();
    // Neither address is used: no allowance read, no pause read, no transaction.
    expect(accountRead).not.toHaveBeenCalled();
    expect(chainRead).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "paused" }));
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("says when the agent has no vault on chain", async () => {
    account.address = CREDITED;
    registryAgent.vault = "0x0000000000000000000000000000000000000000";
    wrap(<AgentDetail label="homeless" />);
    const { p, submit } = await panel();
    expect(await within(p).findByText("This agent has no vault yet.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("keeps the form disabled when the registry read fails, with a retry", async () => {
    account.address = CREDITED;
    chainRead.mockImplementationOnce(async () => {
      throw new Error("rpc down");
    });
    wrap(<AgentDetail label="homeless" />);
    const { p, submit } = await panel();
    expect(await within(p).findByRole("alert")).toHaveTextContent("Could not check the agent's vault on chain: rpc down");
    expect(submit).toBeDisabled();
    fireEvent.click(within(p).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    expect(within(p).getByRole("button", { name: "Donate" })).toBeEnabled();
  });

  it("never offers approve when the allowance cannot be read, and retries the read", async () => {
    account.address = CREDITED;
    accountRead.mockImplementation(async ({ functionName }) => {
      if (functionName === "allowance") throw new Error("allowance unavailable");
      return 100_000_000n;
    });
    wrap(<AgentDetail label="homeless" />);
    const { p, amount, submit } = await panel();
    expect(await within(p).findByRole("alert")).toHaveTextContent("Could not read your USDC balance and allowance: allowance unavailable");
    fireEvent.change(amount, { target: { value: "5" } });
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("Donate 5 USDC");
    fireEvent.submit(submit.closest("form")!);
    expect(writeContractAsync).not.toHaveBeenCalled();

    accountRead.mockImplementation(async ({ functionName }) => (functionName === "allowance" ? 5_000_000n : 100_000_000n));
    fireEvent.click(within(p).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(submit).toBeEnabled());
    expect(submit).toHaveTextContent("Donate 5 USDC");
  });

  it("is disabled while allowance and balance are loading", async () => {
    account.address = CREDITED;
    accountRead.mockImplementation(() => new Promise<bigint>(() => {}));
    wrap(<AgentDetail label="homeless" />);
    const { p, submit } = await panel();
    expect(await within(p).findByText("Reading your USDC balance and allowance")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("donates on the next click after a confirmed approval, even if the allowance reads stale", async () => {
    account.address = CREDITED;
    chainTxs.autoConfirm = true;
    // The RPC keeps answering 0: the refetch after the approval is stale.
    wrap(<AgentDetail label="homeless" />);
    const { p, amount } = await panel();
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    fireEvent.change(amount, { target: { value: "10" } });
    fireEvent.click(within(p).getByRole("button", { name: "Approve 10 USDC" }));
    await within(p).findByText("Approved. Now donate to complete the gift.");
    const donate = await within(p).findByRole("button", { name: "Donate 10 USDC" });
    await waitFor(() => expect(donate).toBeEnabled());
    fireEvent.click(donate);
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    expect(writeContractAsync.mock.calls[1]![0]).toMatchObject({ functionName: "donate", address: VAULT, args: [10_000_000n, false] });

    // The donation spent the approval: a larger amount needs a new one.
    await within(p).findByText("Thank you. Your donation is anonymous on this site.");
    fireEvent.change(amount, { target: { value: "20" } });
    expect(await within(p).findByRole("button", { name: "Approve 20 USDC" })).toBeEnabled();
  });

  it("stays disabled while the donation waits for its receipt", async () => {
    account.address = CREDITED;
    accountRead.mockImplementation(async ({ functionName }) => (functionName === "allowance" ? 50_000_000n : 100_000_000n));
    wrap(<AgentDetail label="homeless" />);
    const { p, amount } = await panel();
    await waitFor(() => expect(within(p).getByText("Your USDC balance: 100 USDC")).toBeInTheDocument());
    fireEvent.change(amount, { target: { value: "5" } });
    const donate = within(p).getByRole("button", { name: "Donate 5 USDC" });
    fireEvent.click(donate);
    await within(p).findByText(/Donation submitted: 0x/);
    expect(donate).toBeDisabled();
    fireEvent.submit(donate.closest("form")!);
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });
});

describe("agents index", () => {
  // A block body: beforeEach treats a returned function as a cleanup hook.
  beforeEach(() => {
    listAgents.mockReset();
  });

  it("lists every agent with state, latest epoch and totals, linking to its page", async () => {
    listAgents.mockImplementation(async () => [
      toAgentSummary({ ...agentRow, latest: { epoch: "12", reportRef: `0x${"12".repeat(32)}`, catalogVersion: 3 } })!,
      toAgentSummary({ ...agentRow, categoryBit: 2, category: "hunger", name: "Hunger", label: "hunger", ensName: "hunger.agent.varada.eth", active: false, totals: null })!,
    ]);
    wrap(<AgentIndex root="../" />);
    const list = await screen.findByRole("list", { name: "Agents" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole("link", { name: "Homelessness" })).toHaveAttribute("href", "../agent/homeless/");
    expect(items[0]).toHaveTextContent("homeless.agent.varada.eth");
    expect(items[0]).toHaveTextContent("Active");
    expect(items[0]).toHaveTextContent("epoch 12");
    expect(items[0]).toHaveTextContent("Donated: 1,234.56 USDC");
    expect(items[0]).toHaveTextContent("Given: 500 USDC");
    expect(items[1]).toHaveTextContent("Paused");
    expect(items[1]).toHaveTextContent("none yet");
    expect(items[1]).toHaveTextContent("Donated: 0 USDC");
  });

  it("falls back to the SDK's agent list when the indexer fails", async () => {
    listAgents.mockImplementation(async () => {
      throw new Error("agents_unavailable");
    });
    wrap(<AgentIndex />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load agents: agents_unavailable"));
    const links = within(screen.getByRole("list", { name: "Agents" })).getAllByRole("link");
    expect(links).toHaveLength(20);
    expect(links.some((a) => a.getAttribute("href") === "./agent/homeless/")).toBe(true);
  });
});
