"use client";

import { useEffect, useState } from "react";
import { AgentDetail } from "@/components/agent-detail";
import { AgentIndex } from "@/components/agent-index";
import { useAppConfig } from "@/components/providers";
import { TokenDetail } from "@/components/token-detail";
import { TokenList } from "@/components/token-list";
import { agentFromLocation, tokenLabelFromLocation } from "@/lib/host";

/** What the root page shows on this host. */
export type HostRoute =
  | { kind: "agent"; label: string } // `<label>.agent.<parent>` or `?agent=<label>`
  | { kind: "agents" } // `agent.<parent>` or `?agent=`
  | { kind: "token"; label: string } // `<label>.<parent>` or `?label=<label>`
  | { kind: "home" };

export function hostRoute(loc: Pick<Location, "hostname" | "search">, parent: string): HostRoute {
  const agent = agentFromLocation(loc, parent);
  if (agent !== null) return agent ? { kind: "agent", label: agent } : { kind: "agents" };
  const label = tokenLabelFromLocation(loc, parent);
  return label ? { kind: "token", label } : { kind: "home" };
}

/** The route for the current location; undefined until read (the page is statically exported, so only the client knows its host). */
export function useHostRoute(): HostRoute | undefined {
  const config = useAppConfig();
  const [route, setRoute] = useState<HostRoute | undefined>(undefined);
  useEffect(() => setRoute(hostRoute(window.location, config.ensParentName)), [config.ensParentName]);
  return route;
}

/** The label the page is served for (`<label>.<parent>` gateway host or `?label=`); undefined until read. */
export function useTokenLabel(): string | null | undefined {
  const route = useHostRoute();
  if (route === undefined) return undefined;
  return route.kind === "token" ? route.label : null;
}

/**
 * Root page: a curator agent's page on `<cause>.agent.<parent>`, the agents index on `agent.<parent>`,
 * a token's own page on its ENS name, the token list everywhere else.
 */
export function HomeRoute() {
  const route = useHostRoute();
  if (route === undefined) return <p role="status">Loading</p>;
  switch (route.kind) {
    case "agent":
      return <AgentDetail label={route.label} />;
    case "agents":
      return <AgentIndex />;
    case "token":
      return <TokenDetail label={route.label} />;
    default:
      return <TokenList />;
  }
}
