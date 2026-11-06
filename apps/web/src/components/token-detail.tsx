"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { CATEGORIES, isValidLabel, REGIONS } from "@verada/sdk";
import { useAppConfig, useDeps } from "@/components/providers";
import { categoryLabel, regionLabel } from "@/components/catalog-browser";
import { EditProfilePanel } from "@/components/edit-profile-panel";
import { EpochPanel } from "@/components/epoch-panel";
import { AppLink } from "@/components/nav";
import { ShortlistEditor } from "@/components/shortlist-editor";
import { TakeoverPanel } from "@/components/takeover-panel";
import { TokenProfileView } from "@/components/token-profile-view";
import { agentPath, agentsForFocus, listAgents } from "@/lib/agents";
import type { TokenFocus } from "@/lib/indexer";
import { loadTokenDetail, resolveTokenLabel } from "@/lib/data";
import { label as displayLabel } from "@/lib/indexer";
import { readTokenAddress } from "@/lib/token-address";

/**
 * Single client-side page for every token. The token comes from the URL (`?address=`), or, on a
 * token's own ENS name or at `token/?label=`, from the label (resolved on-chain, then through the indexer).
 */
export function TokenDetail({ label: labelProp }: { label?: string | null }) {
  const config = useAppConfig();
  const deps = useDeps();
  const [fromUrl, setFromUrl] = useState<string | null | undefined>(undefined);
  const [urlLabel, setUrlLabel] = useState<string | null>(null);

  useEffect(() => {
    if (labelProp) return;
    const read = () => {
      const a = readTokenAddress(window.location.search, window.location.hash);
      setFromUrl(a);
      // token/?label=<label>: the plain-DNS route (<site>/<label>, via 404.html) lands here.
      const l = new URLSearchParams(window.location.search).get("label")?.trim().toLowerCase() ?? "";
      setUrlLabel(a === null && isValidLabel(l) ? l : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [labelProp]);
  const label = labelProp ?? urlLabel;

  const resolved = useQuery({
    queryKey: ["label-address", label],
    queryFn: () => resolveTokenLabel(config, deps, label as string),
    enabled: Boolean(label),
    retry: false,
  });

  const address = label ? resolved.data?.data : fromUrl;
  const { data, error, isLoading } = useQuery({
    queryKey: ["token-detail", address],
    queryFn: () => loadTokenDetail(config, deps, address as string),
    enabled: Boolean(address),
    retry: false,
  });

  if (label) {
    if (resolved.isLoading) return <p role="status">Resolving {label}.{config.ensParentName}</p>;
    if (resolved.error) return <p role="alert">Could not resolve {label}.{config.ensParentName}: {resolved.error instanceof Error ? resolved.error.message : "unknown error"}</p>;
    if (resolved.data && !resolved.data.data) return <p role="alert">No token has the name {label}.{config.ensParentName}.</p>;
  } else {
    if (fromUrl === undefined) return <p role="status">Loading</p>;
    if (fromUrl === null) return <p role="alert">Provide a token address or label, e.g. token/?address=0x... or token/?label=name</p>;
  }
  if (!address || !isAddress(address)) return <p role="status">Loading</p>;
  const token = data?.data;
  const tokenAddress = getAddress(address) as Address;

  return (
    <section>
      <h1>{token ? displayLabel(token) : address}</h1>
      {isLoading && <p role="status">Loading</p>}
      {error && <p role="alert">Could not load token: {error instanceof Error ? error.message : "unknown error"}</p>}
      {data && !token && <p role="alert">Token not found.</p>}
      {data?.source === "chain" && <p role="note">Indexer unreachable; showing data read directly from the chain.</p>}
      <TokenProfileView address={tokenAddress} token={token ?? null} source={data?.source} />
      {token && (
        <>
          <FocusView focus={token.focus} />
          <CuratedBy focus={token.focus} />
          <EpochPanel token={tokenAddress} detail={token} />
          <EditProfilePanel token={tokenAddress} profile={token.profile} />
          <ShortlistEditor token={tokenAddress} detail={token} />
          <TakeoverPanel token={tokenAddress} controller={token.profile?.controller ?? null} />
        </>
      )}
    </section>
  );
}

/** The cause focus fixed at launch: the categories and regions every ballot draws from. */
function FocusView({ focus }: { focus: TokenFocus | null }) {
  if (!focus) return null;
  const all = (list: string[], total: number) => list.length === 0 || list.length >= total;
  return (
    <section aria-label="Cause focus">
      <h2>Cause focus</h2>
      <p>
        Causes: {all(focus.categories, CATEGORIES.length) ? "any" : focus.categories.map(categoryLabel).join(", ")}. Regions:{" "}
        {all(focus.regions, REGIONS.length) ? "any" : focus.regions.map(regionLabel).join(", ")}. Fixed at launch; every charity in
        the catalogue that matches can be drawn onto a ballot.
      </p>
    </section>
  );
}

/**
 * The curator agents whose cause is in the token's focus: each ranks charities for its cause every
 * week, and its picks can fill the ballot slots after the pins.
 */
export function CuratedBy({ focus }: { focus: TokenFocus | null }) {
  const config = useAppConfig();
  const deps = useDeps();
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => listAgents(deps.indexer),
    enabled: Boolean(focus),
    retry: false,
    staleTime: 300_000,
  });
  if (!focus) return null;
  const matching = agents.data ? agentsForFocus(agents.data, focus) : [];
  return (
    <section aria-label="Curated by">
      <h2>Curated by</h2>
      {agents.isLoading && <p role="status">Loading curator agents</p>}
      {agents.error && <p role="note">Curator agents are unavailable right now.</p>}
      {agents.data && matching.length === 0 && <p>No curator agent covers this token&apos;s causes yet.</p>}
      {matching.length > 0 && (
        <>
          <p>Curator agents for this token&apos;s causes. Their weekly picks fill the ballot slots after the pinned causes.</p>
          <ul>
            {matching.map((a) => (
              <li key={a.label}>
                <AppLink to={agentPath(a.label)}>{a.name}</AppLink> ({a.ensName || `${a.label}.agent.${config.ensParentName}`}): {a.active ? "active" : "inactive"}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
