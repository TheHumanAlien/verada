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
vi.mock("@/components/agent-detail", () => ({
  AgentDetail: ({ label, region }: { label: string; region?: string }) => <p>agent page for {label}{region ? ` in ${region}` : ""}</p>,
}));
vi.mock("@/components/agent-index", () => ({ AgentIndex: () => <p>agents index</p> }));

describe("hostRoute", () => {
  it.each([
    ["homeless.agent.varada.eth.limo", "", { kind: "agent", label: "homeless" }],
    ["hunger.agent.varada.eth.link", "", { kind: "agent", label: "hunger" }],
    ["agent.varada.eth.limo", "", { kind: "agents" }],
    // An agent host with an unknown label lands on the index, never on a token page.
    ["nope.agent.varada.eth.limo", "", { kind: "agents" }],
    ["homeless.agent.varada.eth.limo", "?label=pepe", { kind: "agent", label: "homeless" }],
    ["pepe.varada.eth.limo", "", { kind: "token", label: "pepe" }],
    ["varada.eth.limo", "", { kind: "home" }],
    ["localhost", "?agent=homeless", { kind: "agent", label: "homeless" }],
    ["localhost", "?agent=", { kind: "agents" }],
    ["localhost", "?agent=nope", { kind: "home" }],
    ["localhost", "?label=moon-cat", { kind: "token", label: "moon-cat" }],
  ])("%s%s -> %j", async (hostname, search, expected) => {
    const { hostRoute } = await import("@/components/home-route");
    expect(hostRoute(loc(hostname, search), "varada.eth")).toEqual(expected);
  });

  it("follows a custom parent name", async () => {
    const { hostRoute } = await import("@/components/home-route");
    expect(hostRoute(loc("homeless.agent.example.eth.limo"), "example.eth")).toEqual({ kind: "agent", label: "homeless" });
    expect(hostRoute(loc("homeless.agent.varada.eth.limo"), "example.eth")).toEqual({ kind: "home" });
  });
});

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

  it("renders an agent's page for ?agent=<label> and the agents index for ?agent=", async () => {
    const { HomeRoute } = await import("@/components/home-route");
    window.history.replaceState(null, "", "/?agent=homeless&label=moon-cat");
    const { unmount } = render(<HomeRoute />);
    await waitFor(() => expect(screen.getByText("agent page for homeless")).toBeInTheDocument());
    expect(screen.queryByText(/token page/)).toBeNull();
    unmount();
    window.history.replaceState(null, "", "/?agent=");
    render(<HomeRoute />);
    await waitFor(() => expect(screen.getByText("agents index")).toBeInTheDocument());
    window.history.replaceState(null, "", "/");
  });
});
