import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CauseSearch } from "@/components/cause-search";
import { IndexerClient } from "@/lib/indexer";

const fetchMock = vi.fn();
vi.mock("@/components/providers", () => ({
  useDeps: () => ({ indexer: new IndexerClient(["https://idx.example"], { fetchImpl: fetchMock as unknown as typeof fetch }), chain: () => { throw new Error("unused"); } }),
}));

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("CauseSearch", () => {
  it("renders names from the indexer and loads the next page", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ name: "Alpha Fund", id: "0x1", orgId: "1", address: "0x00000000000000000000000000000000000000aa", isDeployed: true }], nextCursor: "c2" }))
      .mockResolvedValueOnce(json({ items: [{ name: "Beta Trust", id: "0x2", orgId: "2", address: null, isDeployed: false }], nextCursor: null }));
    render(<CauseSearch />);
    fireEvent.change(screen.getByLabelText(/search nonprofits/i), { target: { value: "fund" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText(/Alpha Fund/)).toBeInTheDocument());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://idx.example/api/causes/search?q=fund");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText(/Beta Trust/)).toBeInTheDocument());
    expect(screen.getByText(/Alpha Fund/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://idx.example/api/causes/search?q=fund&cursor=c2");
  });

  it("shows an alert when the search fails", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 400));
    render(<CauseSearch />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
