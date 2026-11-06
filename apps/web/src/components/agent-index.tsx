"use client";

import { useQuery } from "@tanstack/react-query";
import { AGENT_CATEGORIES, agentName } from "@verada/sdk";
import { agentHref, causeName, usdcText } from "@/components/agent-common";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { listAgents } from "@/lib/agents";

/** Every curator agent (one per cause) with its state, newest report epoch and vault totals. */
export function AgentIndex({ root = "./" }: { root?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const { data, error, isLoading } = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), retry: false });

  return (
    <section>
      <h1>Curator agents</h1>
      <p>
        Each cause has a curator agent. Every week it reads the news for its cause, ranks up to 32 charities per region for the next
        ballots, publishes its picks on chain with a report, and gives from its own USDC vault to the charities it ranks.
      </p>
      {isLoading && <p role="status">Loading</p>}
      {error && <p role="alert">Could not load agents: {errorText(error)}</p>}
      {data && data.length === 0 && <p>No agents are registered yet.</p>}
      {data && data.length > 0 && (
        <ul aria-label="Agents">
          {data.map((a) => (
            <li key={a.label}>
              <h2>
                <a href={agentHref(root, a.label)}>{a.name}</a>
              </h2>
              <p>
                {a.ensName || agentName(a.label, config.ensParentName)}. Cause: {causeName(a.category)}. {a.active ? "Active" : "Paused"}.
              </p>
              <p>
                Latest report: {a.latest ? `epoch ${a.latest.epoch}` : "none yet"}. Donated: {usdcText(a.totals?.donated ?? "0")}. Given:{" "}
                {usdcText(a.totals?.given ?? "0")}.
              </p>
            </li>
          ))}
        </ul>
      )}
      {error && (
        // The agents are fixed by the SDK, so their pages are still reachable without the indexer.
        <ul aria-label="Agents">
          {AGENT_CATEGORIES.map((c) => (
            <li key={c.ensLabel}>
              <a href={agentHref(root, c.ensLabel)}>{c.label}</a> ({agentName(c.ensLabel, config.ensParentName)})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
