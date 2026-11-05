"use client";

import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { getTokenTextRecord, swarmGatewayUrl, TOKEN_TEXT_KEYS } from "@verada/sdk";
import type { Address } from "viem";
import { useAppConfig, useDeps } from "@/components/providers";
import type { Source } from "@/lib/data";
import { ensGatewayUrl } from "@/lib/host";
import type { TokenDetail } from "@/lib/indexer";

const TEXT_FIELDS: { key: string; label: string }[] = [
  { key: TOKEN_TEXT_KEYS.description, label: "Description" },
  { key: TOKEN_TEXT_KEYS.url, label: "Website" },
  { key: TOKEN_TEXT_KEYS.twitter, label: "Twitter" },
  { key: TOKEN_TEXT_KEYS.telegram, label: "Telegram" },
  { key: TOKEN_TEXT_KEYS.discord, label: "Discord" },
  { key: TOKEN_TEXT_KEYS.github, label: "GitHub" },
];

function logoUrl(gateway: string | undefined, ref: string | null | undefined): string | null {
  if (!gateway || !ref) return null;
  try {
    return swarmGatewayUrl(gateway, ref);
  } catch {
    return null;
  }
}

/** Only http(s) links are rendered as links. */
function safeHref(value: string): string | null {
  return /^https?:\/\//i.test(value) ? value : null;
}

export function TokenProfileView({ address, token, source }: { address: Address; token: TokenDetail | null; source?: Source }) {
  const config = useAppConfig();
  const deps = useDeps();
  const profile = token?.profile ?? null;
  const label = profile?.label ?? token?.label ?? null;
  const ensName = label ? `${label}.${config.ensParentName}` : null;

  // The indexer's profile normally carries text records; read them through ENS when it does not.
  const needsChainTexts = Boolean(label) && source === "indexer" && profile !== null && Object.keys(profile.textRecords).length === 0;
  const chainTexts = useQuery({
    queryKey: ["text-records", label, config.ensParentName],
    queryFn: async () => {
      const out: Record<string, string> = {};
      await Promise.all(
        TEXT_FIELDS.map(async ({ key }) => {
          const v = await getTokenTextRecord(deps.chain(), label as string, key, config.ensParentName).catch(() => null);
          if (v) out[key] = v;
        }),
      );
      return out;
    },
    enabled: needsChainTexts,
    retry: false,
    staleTime: 60_000,
  });
  const texts = { ...(chainTexts.data ?? {}), ...(profile?.textRecords ?? {}) };
  const logo = logoUrl(config.swarmGatewayUrl, profile?.logoRef ?? token?.logoRef);

  return (
    <div>
      {logo && <img src={logo} alt={`${token?.symbol || "Token"} logo`} width={96} height={96} referrerPolicy="no-referrer" />}
      {profile?.suppressed && <p role="note">This profile is suppressed by the registry owner: its ENS records resolve empty.</p>}
      <dl>
        <dt>Address</dt>
        <dd>{address}</dd>
        {token?.name && (
          <>
            <dt>Name</dt>
            <dd>{token.name}</dd>
          </>
        )}
        {token?.symbol && (
          <>
            <dt>Symbol</dt>
            <dd>{token.symbol}</dd>
          </>
        )}
        {ensName && label && (
          <>
            <dt>ENS name</dt>
            <dd>
              {ensName} (<a href={ensGatewayUrl(label, config.ensParentName)}>open on eth.limo</a>)
            </dd>
          </>
        )}
        {token?.creator && (
          <>
            <dt>Creator</dt>
            <dd>{token.creator}</dd>
          </>
        )}
        {profile && (
          <>
            <dt>Profile controller</dt>
            <dd>{profile.controller ?? "none"}</dd>
            <dt>Profile editor</dt>
            <dd>{profile.editor ?? "none"}</dd>
          </>
        )}
        {token?.feeBps !== undefined && (
          <>
            <dt>Fee (bps)</dt>
            <dd>{token.feeBps}</dd>
          </>
        )}
        {token?.metadataURI && (
          <>
            <dt>Metadata</dt>
            <dd>{token.metadataURI}</dd>
          </>
        )}
        {TEXT_FIELDS.filter(({ key }) => texts[key]).map(({ key, label: name }) => {
          const value = texts[key]!;
          const href = safeHref(value);
          return (
            <Fragment key={key}>
              <dt>{name}</dt>
              <dd>{href ? <a href={href} rel="noreferrer noopener">{value}</a> : value}</dd>
            </Fragment>
          );
        })}
      </dl>
    </div>
  );
}
