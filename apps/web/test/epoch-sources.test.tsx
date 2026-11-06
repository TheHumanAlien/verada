import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { epochOptionSources, IndexerClient, toEpochDetail, type TokenDetail } from "@/lib/indexer";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const CAUSE_A = `0x${"0a".repeat(32)}`;
const CAUSE_B = `0x${"0b".repeat(32)}`;
const CAUSE_C = `0x${"0c".repeat(32)}`;

const config: AppConfig = {
  ...envDefaults(),
  indexerUrls: ["https://idx.example"],
  governorAddress: "0x00000000000000000000000000000000000000d1",
  votingSchemeAddress: "0x00000000000000000000000000000000000000d3",
};

const EPOCH_PATH = `/api/epochs/${TOKEN}/5`;
const baseEpoch = {
  epoch: "5",
  options: [CAUSE_A, CAUSE_B, CAUSE_C],
  prepared: true,
  poolSize: "40",
  poll: { opened: true, closed: false, isFinal: false, optionCount: 3, counts: null, ballotCount: 0, scheme: config.votingSchemeAddress },
  start: 1700000000,
  end: 1700604800,
  snapshot: 1699999999,
};
const fixtures: Record<string, unknown> = {
  "/api/causes": {
    items: [
      { causeId: CAUSE_A, name: "Alpha Fund", active: true },
      { causeId: CAUSE_B, name: "Beta Trust", active: true },
      { causeId: CAUSE_C, name: "Gamma Aid", active: true },
    ],
    nextCursor: null,
  },
};

const fetchMock = vi.fn(async (input: string) => {
  const path = new URL(input).pathname;
  return path in fixtures
    ? { ok: true, status: 200, json: async () => fixtures[path] }
    : { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
});
const indexer = new IndexerClient(config.indexerUrls, { fetchImpl: fetchMock as unknown as typeof fetch });
const chainRead = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === "currentEpoch") return 5n;
  throw new Error(`unexpected public read ${functionName}`);
});

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract: chainRead }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, error: null }),
}));

const { EpochPanel, ballotMakeup, shownOptionSources } = await import("@/components/epoch-panel");

const detail = { address: TOKEN, shortlist: [CAUSE_A], focus: null } as unknown as TokenDetail;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EpochPanel token={TOKEN} detail={detail} />
    </QueryClientProvider>,
  );
}

/** The source tag rendered after each option, in ballot order ("" when none). */
async function optionTags(): Promise<string[]> {
  const panel = screen.getByRole("region", { name: "Current epoch" });
  await waitFor(() => expect(within(panel).getByText(/Alpha Fund/)).toBeInTheDocument());
  const list = within(panel).getByRole("list");
  return within(list)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[data-source]")?.textContent ?? "");
}

describe("epoch option sources (parsing)", () => {
  it("keeps the indexer's optionSources and counts", () => {
    const d = toEpochDetail({ ...baseEpoch, pinnedCount: 1, curatedDrawn: 3, curatedCount: 1, optionSources: ["pinned", "curated", "rotation"] });
    expect(d?.pinnedCount).toBe(1);
    expect(d?.curatedCount).toBe(1);
    expect(d?.optionSources).toEqual(["pinned", "curated", "rotation"]);
  });

  it("derives sources from the counts when optionSources is missing or misaligned", () => {
    expect(toEpochDetail({ ...baseEpoch, pinnedCount: 1, curatedCount: 1 })?.optionSources).toEqual(["pinned", "curated", "rotation"]);
    expect(toEpochDetail({ ...baseEpoch, pinnedCount: 0, curatedCount: 2, optionSources: ["curated"] })?.optionSources).toEqual([
      "curated",
      "curated",
      "rotation",
    ]);
    expect(toEpochDetail({ ...baseEpoch, pinnedCount: "2", curatedCount: "0" })?.optionSources).toEqual(["pinned", "pinned", "rotation"]);
  });

  it("handles older indexers and unprepared ballots", () => {
    // No counts at all: nothing is known.
    const old = toEpochDetail(baseEpoch);
    expect(old?.optionSources).toEqual([null, null, null]);
    expect(old?.pinnedCount).toBeUndefined();
    expect(old?.curatedCount).toBeUndefined();
    // pinnedCount only (before curated ballots): the pins are known, the rest is not.
    expect(toEpochDetail({ ...baseEpoch, pinnedCount: 1 })?.optionSources).toEqual(["pinned", null, null]);
    // Unprepared ballot: counts are null.
    expect(toEpochDetail({ epoch: "6", options: [], prepared: false, pinnedCount: null, curatedCount: null, optionSources: [] })?.optionSources).toEqual([]);
    // Unknown entries are dropped to null.
    expect(toEpochDetail({ ...baseEpoch, optionSources: ["pinned", "bogus", null] })?.optionSources).toEqual(["pinned", null, null]);
  });

  it("follows the indexer rule for each index", () => {
    const sources = epochOptionSources({ options: ["a", "b", "c", "d", "e"], prepared: true, pinnedCount: 2, curatedCount: 2 });
    expect(sources).toEqual(["pinned", "pinned", "curated", "curated", "rotation"]);
    expect(epochOptionSources({ options: ["a"], prepared: false, pinnedCount: 1, curatedCount: 0 })).toEqual([null]);
  });

  it("labels the pins before preparation and summarizes known sources", () => {
    expect(shownOptionSources(false, [CAUSE_A], null)).toEqual(["pinned"]);
    expect(shownOptionSources(true, [CAUSE_A, CAUSE_B], { options: [CAUSE_A, CAUSE_B], optionSources: undefined })).toEqual([null, null]);
    expect(ballotMakeup(["pinned", "curated", "curated", "rotation"])).toBe("1 pinned, 2 curated, 1 rotation");
    expect(ballotMakeup(["rotation", "rotation"])).toBe("2 rotation");
    expect(ballotMakeup(["pinned", null])).toBeNull();
    expect(ballotMakeup([])).toBeNull();
  });
});

describe("epoch panel option labels", () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("tags each option Pinned / Curated / Rotation from the indexer", async () => {
    fixtures[EPOCH_PATH] = { ...baseEpoch, pinnedCount: 1, curatedDrawn: 2, curatedCount: 1, optionSources: ["pinned", "curated", "rotation"] };
    renderPanel();
    expect(await optionTags()).toEqual(["[Pinned]", "[Curated]", "[Rotation]"]);
    const panel = screen.getByRole("region", { name: "Current epoch" });
    expect(within(panel).getByText(/Options: 1 pinned, 1 curated, 1 rotation\./)).toBeInTheDocument();
    expect(within(panel).getByTitle(/curator agent/)).toHaveTextContent("[Curated]");
    // No agent link: the API does not say which agent's bucket a curated pick came from.
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("derives the tags from pinnedCount / curatedCount when optionSources is absent", async () => {
    fixtures[EPOCH_PATH] = { ...baseEpoch, pinnedCount: 0, curatedCount: 2 };
    renderPanel();
    expect(await optionTags()).toEqual(["[Curated]", "[Curated]", "[Rotation]"]);
  });

  it("shows no tags for an older indexer without the fields", async () => {
    fixtures[EPOCH_PATH] = { ...baseEpoch };
    renderPanel();
    expect(await optionTags()).toEqual(["", "", ""]);
    const panel = screen.getByRole("region", { name: "Current epoch" });
    expect(within(panel).queryByText(/^Options:/)).toBeNull();
    expect(within(panel).getByText(/Gamma Aid/)).toBeInTheDocument();
  });

  it("tags the token's pins before the ballot is prepared", async () => {
    fixtures[EPOCH_PATH] = { epoch: "5", options: [], prepared: false, poll: null, pinnedCount: null, curatedCount: null, optionSources: [] };
    renderPanel();
    expect(await optionTags()).toEqual(["[Pinned]"]);
    const panel = screen.getByRole("region", { name: "Current epoch" });
    expect(within(panel).getByText(/not prepared yet/)).toHaveTextContent(/curator agents/);
  });
});
