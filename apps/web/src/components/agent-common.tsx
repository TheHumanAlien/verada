import { CATEGORIES, REGIONS } from "@verada/sdk";
import { agentPath, formatUsdc } from "@/lib/agents";
import { safeHttpUrl, SafeLink } from "@/lib/markdown";

/**
 * Agent pages live at different depths (`agent/`, `agent/<label>/`, `agent/<label>/<region>/`, or
 * the site root on `<label>.agent.<parent>`), so links are built from `root`: the relative path from
 * the current page to the site root ("./", "../", "../../", ...). Plain relative hrefs keep working
 * under /bzz/<hash>/, bzz subdomains and ENS gateways.
 */
export function agentHref(root: string, label: string, region?: string): string {
  return `${root}${agentPath(label, region).replace(/^\//, "")}`;
}

export function agentsIndexHref(root: string): string {
  return `${root}agent/`;
}

export const regionName = (slug: string | null) => (slug ? (REGIONS.find((r) => r.slug === slug)?.label ?? slug) : "Unknown region");
export const causeName = (slug: string | null) => (slug ? (CATEGORIES.find((c) => c.slug === slug)?.label ?? slug) : "Unknown cause");

export const usdcText = (amount: bigint | string) => `${formatUsdc(amount)} USDC`;

/** An untrusted source URL: linked (safely) by its hostname, or shown as text when it is not http(s). */
export function SourceLink({ url }: { url: string }) {
  const safe = safeHttpUrl(url);
  return <SafeLink href={url}>{safe ? new URL(safe).hostname : url}</SafeLink>;
}
