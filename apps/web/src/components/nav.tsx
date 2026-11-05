"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Relative link prefix for the current page. All routes are one directory deep
 * (trailingSlash), so pages are either at the site root or one level below it.
 */
export function useRel(): (path: string) => string {
  const segment = useSelectedLayoutSegment();
  const prefix = segment ? "../" : "./";
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
      <AppLink to="governance/">Governance</AppLink>
    </nav>
  );
}
