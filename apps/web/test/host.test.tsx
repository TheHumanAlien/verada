import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ensGatewayUrl, tokenLabelFromLocation } from "@/lib/host";

const loc = (hostname: string, search = "") => ({ hostname, search });

describe("tokenLabelFromLocation", () => {
  it.each([
    ["pepe.varada.eth.limo", "", "pepe"],
    ["pepe.varada.eth.link", "", "pepe"],
    ["pepe.varada.bzz.link", "", "pepe"],
    ["varada.eth.limo", "", null],
    ["a.b.varada.eth.limo", "", null],
    ["localhost", "", null],
    ["127.0.0.1", "?label=moon-cat", "moon-cat"],
    ["pepe.varada.eth.limo", "?label=other", "other"],
    ["localhost", "?label=Bad Label", null],
    ["other.eth.limo", "", null],
  ])("%s%s -> %s", (hostname, search, expected) => {
    expect(tokenLabelFromLocation(loc(hostname, search))).toBe(expected);
  });

  it("follows a custom parent name", () => {
    expect(tokenLabelFromLocation(loc("pepe.example.eth.limo"), "example.eth")).toBe("pepe");
    expect(tokenLabelFromLocation(loc("pepe.varada.eth.limo"), "example.eth")).toBeNull();
  });

  it("builds the eth.limo gateway URL", () => {
    expect(ensGatewayUrl("pepe")).toBe("https://pepe.varada.eth.limo/");
  });
});

vi.mock("@/components/providers", () => ({ useAppConfig: () => ({ ensParentName: "varada.eth" }) }));
vi.mock("@/components/token-detail", () => ({ TokenDetail: ({ label }: { label: string }) => <p>token page for {label}</p> }));
vi.mock("@/components/token-list", () => ({ TokenList: () => <p>token list</p> }));

describe("HomeRoute", () => {
  it("renders the token page for ?label= and the list otherwise", async () => {
    const { HomeRoute } = await import("@/components/home-route");
    window.history.replaceState(null, "", "/?label=moon-cat");
    const { unmount } = render(<HomeRoute />);
    await waitFor(() => expect(screen.getByText("token page for moon-cat")).toBeInTheDocument());
    unmount();
    window.history.replaceState(null, "", "/");
    render(<HomeRoute />);
    await waitFor(() => expect(screen.getByText("token list")).toBeInTheDocument());
  });
});
