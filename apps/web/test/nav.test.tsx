import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const segments = { value: [] as string[] | null };
vi.mock("next/navigation", () => ({ useSelectedLayoutSegments: () => segments.value }));

const { Nav, relativeRoot } = await import("@/components/nav");

function hrefs(selected: string[] | null): Record<string, string | null> {
  segments.value = selected;
  const { unmount } = render(<Nav />);
  const links = within(screen.getByRole("navigation")).getAllByRole("link");
  const out = Object.fromEntries(links.map((a) => [a.textContent ?? "", a.getAttribute("href")]));
  unmount();
  return out;
}

describe("Nav", () => {
  it("links relative to the site root at every page depth", () => {
    expect(hrefs([])).toEqual({ Tokens: "./", Launch: "./launch/", Causes: "./causes/", Governance: "./governance/", Agents: "./agent/" });
    expect(hrefs(["token"])).toMatchObject({ Tokens: "../", Launch: "../launch/", Agents: "../agent/" });
    expect(hrefs(["agent", "hunger"])).toMatchObject({ Tokens: "../../", Governance: "../../governance/", Agents: "../../agent/" });
    expect(hrefs(["agent", "hunger", "africa"])).toMatchObject({ Tokens: "../../../", Causes: "../../../causes/", Agents: "../../../agent/" });
  });

  it("treats a missing router context as the root", () => {
    expect(hrefs(null)).toMatchObject({ Tokens: "./", Agents: "./agent/" });
  });
});

describe("relativeRoot", () => {
  it("skips route groups and internal segments", () => {
    expect(relativeRoot([])).toBe("./");
    expect(relativeRoot(["__PAGE__"])).toBe("./");
    expect(relativeRoot(["(site)", "agent", "hunger", "__PAGE__"])).toBe("../../");
    expect(relativeRoot(["agent", "__DEFAULT__"])).toBe("../");
    expect(relativeRoot(undefined)).toBe("./");
  });
});
