import { ENS_PARENT_NAME, agentByLabel, isValidLabel, parseGatewayHostname } from "@verada/sdk";

/**
 * Token label for the current page, if it is a token page served on its own ENS name:
 *  - `?label=<label>` (local testing; any host) wins,
 *  - otherwise the gateway hostname, e.g. `pepe.varada.eth.limo` gives `pepe`.
 * Returns null for the main site (`varada.eth.limo`, localhost, a `/bzz/<ref>/` path gateway) and
 * for agent pages (any location where `agentFromLocation` is not null), whatever `?label=` says.
 */
export function tokenLabelFromLocation(
  loc: Pick<Location, "hostname" | "search"> | undefined = typeof window === "undefined" ? undefined : window.location,
  parent: string = ENS_PARENT_NAME,
): string | null {
  if (!loc) return null;
  if (agentFromLocation(loc, parent) !== null) return null;
  const override = new URLSearchParams(loc.search).get("label")?.trim().toLowerCase();
  if (override) return isValidLabel(override) ? override : null;
  return parseGatewayHostname(loc.hostname, parent)?.label ?? null;
}

/**
 * Curator agent context of the current page:
 *  - a string: the agent's label, e.g. `homeless` for `homeless.agent.varada.eth.limo`;
 *  - `""`: the agents index (`agent.varada.eth.limo`), and also an agent host whose label is not a
 *    known agent (`nope.agent.varada.eth.limo`), so it lands on the index instead of the token site;
 *  - null: not an agent page (main site, token hosts, localhost, unrelated hosts, no `window`).
 * `?agent=<label>` (local testing; any host) wins over the hostname: a known label gives the label,
 * `?agent=` (empty) gives `""`, and an unknown label gives null. Labels come back lowercase.
 */
export function agentFromLocation(
  loc: Pick<Location, "hostname" | "search"> | undefined = typeof window === "undefined" ? undefined : window.location,
  parent: string = ENS_PARENT_NAME,
): string | null {
  if (!loc) return null;
  const params = new URLSearchParams(loc.search);
  if (params.has("agent")) {
    const override = (params.get("agent") ?? "").trim().toLowerCase();
    if (override === "") return "";
    return agentByLabel(override) ? override : null;
  }
  const agent = parseGatewayHostname(loc.hostname, parent)?.agent;
  if (agent === undefined) return null;
  return agent && agentByLabel(agent) ? agent.toLowerCase() : "";
}

/** HTTPS gateway URL of a curator agent's page, `<label>.agent.<parent>`, or the agents index when `label` is empty. */
export function agentGatewayUrl(label: string, parent: string = ENS_PARENT_NAME): string {
  return label ? `https://${label}.agent.${parent}.limo/` : `https://agent.${parent}.limo/`;
}

/** HTTPS gateway URL for `<label>.<parent>` (eth.limo). */
export function ensGatewayUrl(label: string, parent: string = ENS_PARENT_NAME): string {
  return `https://${label}.${parent}.limo/`;
}
