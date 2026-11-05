import { ENS_PARENT_NAME, isValidLabel, parseGatewayHostname } from "@verada/sdk";

/**
 * Token label for the current page, if it is a token page served on its own ENS name:
 *  - `?label=<label>` (local testing; any host) wins,
 *  - otherwise the gateway hostname, e.g. `pepe.varada.eth.limo` gives `pepe`.
 * Returns null for the main site (`varada.eth.limo`, localhost, a `/bzz/<ref>/` path gateway).
 */
export function tokenLabelFromLocation(
  loc: Pick<Location, "hostname" | "search"> | undefined = typeof window === "undefined" ? undefined : window.location,
  parent: string = ENS_PARENT_NAME,
): string | null {
  if (!loc) return null;
  const override = new URLSearchParams(loc.search).get("label")?.trim().toLowerCase();
  if (override) return isValidLabel(override) ? override : null;
  return parseGatewayHostname(loc.hostname, parent)?.label ?? null;
}

/** HTTPS gateway URL for `<label>.<parent>` (eth.limo). */
export function ensGatewayUrl(label: string, parent: string = ENS_PARENT_NAME): string {
  return `https://${label}.${parent}.limo/`;
}
