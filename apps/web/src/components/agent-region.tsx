"use client";

import { MAX_WEIGHT } from "@verada/sdk";
import { regionName, SourceLink } from "@/components/agent-common";
import type { AgentRegionReport } from "@/lib/agents";
import { Markdown, SafeLink } from "@/lib/markdown";

/**
 * One region of an agent's weekly report: urgency, summary, ranked picks, newsletter and events.
 * Everything here is LLM-written from untrusted news, so it is rendered as text, through the safe
 * Markdown subset, or as `SafeLink`s; never as HTML.
 */
export function AgentRegionView({ region, headingLevel = 3 }: { region: AgentRegionReport; headingLevel?: 2 | 3 }) {
  const H = `h${headingLevel}` as "h2" | "h3";
  const Sub = `h${headingLevel + 1}` as "h3" | "h4";
  const name = regionName(region.region);
  return (
    <section aria-label={`${name} picks`}>
      <H>{name}</H>
      <p>
        {region.verified ? (
          <strong>Verified on-chain</strong>
        ) : (
          <strong>Not verified on-chain</strong>
        )}
        {region.verified
          ? ": these picks match the root the agent submitted on chain."
          : region.picksRoot
            ? ": the picks in this report do not match the root the agent submitted on chain, so they may not be the ones ballots use."
            : ": the agent submitted no picks for this region on chain."}
        {region.picksRoot && <> Root: <code>{region.picksRoot}</code></>}
      </p>
      <p>
        Urgency weight: {region.weight} / {MAX_WEIGHT}
      </p>
      {region.summary && <p>{region.summary}</p>}

      <Sub>This week&apos;s picks</Sub>
      {region.picks.length === 0 ? (
        <p>No picks for {name} this week.</p>
      ) : (
        <ol aria-label={`${name} ranked picks`}>
          {region.picks.map((p) => (
            <li key={`${p.rank}-${p.orgId}`}>
              <p>
                <strong>
                  #{p.rank + 1} {p.name}
                </strong>{" "}
                (score {p.score}/100)
              </p>
              {p.reasons && <p>{p.reasons}</p>}
              {p.sources.length > 0 && (
                <p>
                  Sources:{" "}
                  {p.sources.map((s, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      <SourceLink url={s} />
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      {region.newsletter && (
        <>
          <Sub>Newsletter</Sub>
          <Markdown source={region.newsletter} headingLevel={headingLevel + 2} />
        </>
      )}

      {region.events.length > 0 && (
        <>
          <Sub>Events</Sub>
          <ul aria-label={`${name} events`}>
            {region.events.map((e, i) => (
              <li key={i}>
                <SafeLink href={e.url}>{e.title || e.url}</SafeLink>
                {e.date && ` (${e.date})`}
                {e.summary && `: ${e.summary}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
