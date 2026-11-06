"use client";

import { useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Relative path from a page to the site root: "./" at the root, then one "../" per URL directory
 * (trailingSlash, so `/agent/hunger/africa/` is three deep). `segments` are the selected layout
 * segments below the root layout; route groups `(name)` and internal keys such as `__PAGE__` are not
 * URL directories and are skipped.
 */
export function relativeRoot(segments: readonly string[] | null | undefined): string {
  const depth = (segments ?? []).filter((s) => s !== "" && !s.startsWith("(") && !s.startsWith("__")).length;
  return depth === 0 ? "./" : "../".repeat(depth);
}

/** Relative link builder for the current page, at any depth. */
export function useRel(): (path: string) => string {
  const prefix = relativeRoot(useSelectedLayoutSegments());
  return (path) => `${prefix}${path.replace(/^\//, "")}`;
}

/** Plain anchor with a relative href: works under /bzz/<hash>/, bzz subdomains and ENS gateways. */
export function AppLink({ to, children }: { to: string; children: ReactNode }) {
  const rel = useRel();
  return <a href={rel(to)}>{children}</a>;
}

export function Nav() {
  return (
    <nav>
      <AppLink to="">Tokens</AppLink> <AppLink to="launch/">Launch</AppLink> <AppLink to="causes/">Causes</AppLink>{" "}
      <AppLink to="governance/">Governance</AppLink> <AppLink to="agent/">Agents</AppLink>
    </nav>
  );
}
