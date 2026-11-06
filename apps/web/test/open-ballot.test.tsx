import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BUCKET_COUNT, bucketId, categoryMaskOf, CuratedPicksUnavailable, regionMaskOf } from "@verada/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { IndexerClient, type TokenDetail } from "@/lib/indexer";
import { openingErrorText } from "@/lib/open-ballot";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const VOTER = "0x00000000000000000000000000000000000000B2";
const ROOT = `0x${"99".repeat(32)}`;
const PROFILES = "0x00000000000000000000000000000000000000f1";
const CATALOG = "0x00000000000000000000000000000000000000f2";
const REGISTRY = "0x00000000000000000000000000000000000000f3";
const HUNGER_AF = bucketId(2, 0);
const orgAt = (i: number) => `0x${(0xa0 + i).toString(16).repeat(32)}`;

const config: AppConfig = {
  ...envDefaults(),
  indexerUrls: ["https://idx.example"],
  governorAddress: "0x00000000000000000000000000000000000000d1",
  votingSchemeAddress: "0x00000000000000000000000000000000000000d3",
};

const fixtures: Record<string, unknown> = {
  "/api/causes": { items: [], nextCursor: null },
  "/api/catalog/entries": {
    root: ROOT,
    items: [0, 1, 2].map((i) => ({ bucket: HUNGER_AF, index: i, orgId: orgAt(i), proof: [`0x${"77".repeat(32)}`] })),
  },
};
const fetchMock = vi.fn(async (input: string) => {
  const path = new URL(input).pathname;
  return path in fixtures
    ? { ok: true, status: 200, json: async () => fixtures[path] }
    : { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
});
const indexer = new IndexerClient(config.indexerUrls, { fetchImpl: fetchMock as unknown as typeof fetch });

const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
sizes[HUNGER_AF] = 3;
const chain = { prepared: false, pool: 0, options: [] as string[] };
const SCHEME = config.votingSchemeAddress;
const chainRead = vi.fn(async ({ functionName }: { functionName: string }) => {
  switch (functionName) {
    case "currentEpoch":
      return 5n;
    case "isPrepared":
      return chain.prepared;
    case "poolOf":
      return [chain.pool > 0 ? 1 : 0, BigInt(chain.pool)];
    case "shortlistFor":
      return [];
    case "ballotSize":
      return 32n;
    case "profileRegistry":
      return PROFILES;
    case "catalog":
      return CATALOG;
    case "registry":
      return REGISTRY;
    case "focusOf":
      return [categoryMaskOf(["hunger"]), regionMaskOf(["africa"])];
    case "bucketSizesOf":
      return sizes;
    case "rootOf":
      return ROOT;
    case "isBlocked":
      return false;
    case "curators":
      return "0x0000000000000000000000000000000000000000";
    // chainEpochDetail
    case "isOpened":
      return chain.prepared && chain.options.length >= 2;
    case "isClosed":
    case "isFinalized":
      return false;
    case "snapshotFor":
    case "epochStart":
      return 1_000n;
    case "voterCount":
      return 0n;
    case "epochScheme":
      return SCHEME;
    case "tallyOf":
      return [false, []];
    case "ballotCount":
      return 0n;
    case "optionCountOf":
      return chain.options.length;
    default:
      throw new Error(`unexpected public read ${functionName}`);
  }
});
/** The ballot lives in its `BallotPrepared` log (the governor keeps only a commitment). */
const chainLogs = vi.fn(async () => (chain.prepared ? [{ args: { orgIds: chain.options } }] : []));
const writeContractAsync = vi.fn(async (_req: unknown) => "0xabc");
/** What the mocked wagmi hooks report: the sent hash and its receipt. */
const wallet: { hash?: string; receipt?: { status: string; blockNumber: bigint } } = {};

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract: chainRead, getBlock: async () => ({ number: 100n, timestamp: 2_000n }), getLogs: chainLogs }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("@/lib/account-reads", () => ({
  createAccountClient: () => ({ readContract: async ({ functionName }: { functionName: string }) => (functionName === "weightOf" ? 10n : false) }),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: VOTER }),
  useWriteContract: () => ({ writeContractAsync, data: wallet.hash, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: wallet.receipt, error: null }),
}));

const { EpochPanel } = await import("@/components/epoch-panel");
const detail = { address: TOKEN, shortlist: [], focus: null } as unknown as TokenDetail;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EpochPanel token={TOKEN} detail={detail} />
    </QueryClientProvider>,
  );
}

/** {@link renderPanel} keeping one QueryClient across re-renders (the wagmi mocks are read on render). */
function renderPanelWithRerender() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <EpochPanel token={TOKEN} detail={detail} />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { rerender: () => r.rerender(ui()) };
}

async function clickOpen() {
  const group = await screen.findByRole("group", { name: "Open ballot" });
  fireEvent.click(within(group).getByRole("button", { name: "Open this week's ballot" }));
  return group;
}

beforeEach(() => {
  writeContractAsync.mockClear();
  chain.prepared = false;
  chain.pool = 0;
  chain.options = [];
  chainLogs.mockClear();
  delete wallet.hash;
  delete wallet.receipt;
  // The indexer has no row for an epoch nobody opened.
  delete fixtures[`/api/epochs/${TOKEN}/5`];
});

describe("open this week's ballot", () => {
  it("sends openEpoch when the ballot needs no draws", async () => {
    renderPanel();
    await clickOpen();
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({
      address: config.governorAddress,
      functionName: "openEpoch",
      args: [TOKEN, 5n],
      chainId: config.chainId,
    });
  });

  it("plans rotation draws with the indexer's proofs, like the keeper", async () => {
    chain.pool = 3;
    renderPanel();
    await clickOpen();
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    const req = writeContractAsync.mock.calls[0]![0] as { functionName: string; args: unknown[] };
    expect(req.functionName).toBe("prepareBallot");
    expect(req.args[0]).toBe(TOKEN);
    expect(req.args[1]).toBe(5n);
    // A pool smaller than the ballot is taken in order.
    expect((req.args[2] as { orgId: string }[]).map((d) => d.orgId)).toEqual([orgAt(0), orgAt(1), orgAt(2)]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/catalog/entries"))).toBe(true);
  });

  it("refuses an indexer catalogue whose root is not the chain's", async () => {
    chain.pool = 3;
    const good = fixtures["/api/catalog/entries"];
    fixtures["/api/catalog/entries"] = { ...(good as object), root: `0x${"55".repeat(32)}` };
    try {
      renderPanel();
      const group = await clickOpen();
      expect(await within(group).findByRole("alert")).toHaveTextContent(/does not match the chain/);
      expect(writeContractAsync).not.toHaveBeenCalled();
    } finally {
      fixtures["/api/catalog/entries"] = good;
    }
  });

  it("is not offered once the ballot is prepared", async () => {
    fixtures[`/api/epochs/${TOKEN}/5`] = {
      epoch: "5",
      options: [orgAt(0), orgAt(1)],
      prepared: true,
      poll: { opened: true, closed: false, isFinal: false, optionCount: 2, counts: null, ballotCount: 0, scheme: config.votingSchemeAddress },
    };
    renderPanel();
    await screen.findByRole("form", { name: "Vote" });
    expect(screen.queryByRole("group", { name: "Open ballot" })).toBeNull();
  });

  it("shows the ballot from chain once the opening confirms, while the indexer still lacks it", async () => {
    const { rerender } = renderPanelWithRerender();
    await clickOpen();
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    // The transaction is mined: the chain has the ballot, the indexer still answers 404.
    chain.prepared = true;
    chain.options = [orgAt(0), orgAt(1)];
    wallet.hash = "0xabc";
    wallet.receipt = { status: "success", blockNumber: 7n };
    rerender();
    await screen.findByRole("form", { name: "Vote" });
    expect(screen.queryByRole("button", { name: "Open this week's ballot" })).toBeNull();
    expect(chainLogs).toHaveBeenCalled();
  });

  it("shows the ballot when it turns out to be open on chain already", async () => {
    chain.prepared = true;
    chain.options = [orgAt(0), orgAt(1)];
    renderPanel();
    await clickOpen();
    await screen.findByRole("form", { name: "Vote" });
    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Open ballot" })).toBeNull();
  });

  it("explains missing curator picks", () => {
    const e = new CuratedPicksUnavailable("no picks");
    e.retryAt = Date.UTC(2026, 10, 2, 6, 0, 30);
    expect(openingErrorText(e)).toMatch(/not published yet\. Try again after 2026-11-02T06:00:30Z/);
  });
});
