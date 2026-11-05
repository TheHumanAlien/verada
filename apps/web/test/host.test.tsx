import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ensGatewayUrl, tokenLabelFromLocation } from "@/lib/host";

const loc = (hostname: string, search = "") => ({ hostname, search });

describe("tokenLabelFromLocation", () => {
  it.each([
    ["pepe.verada.eth.limo", "", "pepe"],
    ["pepe.verada.eth.link", "", "pepe"],
    ["pepe.verada.bzz.link", "", "pepe"],
    ["verada.eth.limo", "", null],
    ["a.b.verada.eth.limo", "", null],
    ["localhost", "", null],
    ["127.0.0.1", "?label=moon-cat", "moon-cat"],
    ["pepe.verada.eth.limo", "?label=other", "other"],
    ["localhost", "?label=Bad Label", null],
    ["other.eth.limo", "", null],
  ])("%s%s -> %s", (hostname, search, expected) => {
    expect(tokenLabelFromLocation(loc(hostname, search))).toBe(expected);
  });

  it("follows a custom parent name", () => {
    expect(tokenLabelFromLocation(loc("pepe.example.eth.limo"), "example.eth")).toBe("pepe");
    expect(tokenLabelFromLocation(loc("pepe.verada.eth.limo"), "example.eth")).toBeNull();
  });

  it("builds the eth.limo gateway URL", () => {
    expect(ensGatewayUrl("pepe")).toBe("https://pepe.verada.eth.limo/");
  });
});

vi.mock("@/components/providers", () => ({ useAppConfig: () => ({ ensParentName: "verada.eth" }) }));
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
