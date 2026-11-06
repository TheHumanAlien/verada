"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent } from "react";
import { REGIONS, agentByLabel, agentName } from "@verada/sdk";
import { agentHref, agentsIndexHref, causeName, regionName, usdcText } from "@/components/agent-common";
import { AgentDonatePanel } from "@/components/agent-donate";
import { AgentRegionView } from "@/components/agent-region";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, formatTime, shortAddress } from "@/components/use-tx";
import { getAgent, getAgentReport, regionReport, type AgentDetail as AgentInfo, type AgentReport } from "@/lib/agents";
import { agentGatewayUrl } from "@/lib/host";
import { Markdown } from "@/lib/markdown";

/** ERC-8004 identity registry on mainnet, where every agent holds its identity token. */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const REGION_ORDER = new Map(REGIONS.map((r, i) => [r.slug, i]));

/**
 * A curator agent's page: identity, vault, the weekly report (per-region picks, newsletter, events),
 * the report archive, totals, credited donors, recent gifts and the donate panel. With `region`, the
 * report shows that region only. `root` is the relative path from this page to the site root ("./"
 * on `<label>.agent.<parent>`, where the root page renders this).
 */
export function AgentDetail({ label, region, root = "./" }: { label: string; region?: string; root?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const def = agentByLabel(label);
  const [chosenEpoch, setChosenEpoch] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["agent", label],
    queryFn: () => getAgent(deps.indexer, label),
    enabled: Boolean(def),
    retry: false,
  });
  const agent = detail.data ?? null;
  const epoch = chosenEpoch ?? agent?.latest?.epoch ?? null;
  const report = useQuery({
    queryKey: ["agent-report", label, epoch],
    queryFn: () => getAgentReport(deps.indexer, label, epoch!),
    enabled: Boolean(agent && epoch !== null),
    retry: false,
  });

  if (!def) return <p role="alert">No curator agent has the name {label}.</p>;
  const ensName = agent?.ensName || agentName(def.ensLabel, config.ensParentName);
  const focus = region ? REGIONS.find((r) => r.slug === region) : undefined;
  if (region && !focus) return <p role="alert">Unknown region {region}.</p>;

  return (
    <section>
      <p>
        <a href={agentsIndexHref(root)}>All agents</a>
        {focus && (
          <>
            {" / "}
            <a href={agentHref(root, def.ensLabel)}>{agent?.name ?? def.label}</a>
          </>
        )}
      </p>
      <h1>
        {agent?.name ?? def.label}
        {focus ? `: ${focus.label}` : ""}
      </h1>
      <p>
        {ensName} (<a href={agentGatewayUrl(def.ensLabel, config.ensParentName)}>open on eth.limo</a>)
      </p>
      {detail.isLoading && <p role="status">Loading</p>}
      {detail.error && <p role="alert">Could not load agent: {errorText(detail.error)}</p>}
      {detail.data === null && <p role="alert">This agent is not registered yet.</p>}
      {agent && (
        <>
          <AgentFacts agent={agent} />
          <ReportSection agent={agent} report={report.data ?? null} loading={report.isLoading} error={report.error} epoch={epoch} region={focus?.slug} root={root} />
          <ReportArchive agent={agent} epoch={epoch} onChoose={setChosenEpoch} />
          {/* The category bit comes from the SDK (static), not the indexer row: it keys the on-chain vault lookup. */}
          <AgentDonatePanel categoryBit={def.bit} vault={agent.vault} name={agent.name} />
          <CreditedDonors agent={agent} />
          <RecentGifts agent={agent} report={report.data ?? null} />
        </>
      )}
    </section>
  );
}

function AgentFacts({ agent }: { agent: AgentInfo }) {
  return (
    <section aria-label="Agent">
      {agent.description && <p>{agent.description}</p>}
      <dl>
        <dt>Cause</dt>
        <dd>{causeName(agent.category)}</dd>
        <dt>State</dt>
        <dd>{agent.active ? "Active" : "Paused"}</dd>
        <dt>Identity</dt>
        <dd title={`ERC-8004 identity registry ${ERC8004_IDENTITY_REGISTRY}`}>ERC-8004 #{agent.agentId}</dd>
        <dt>Vault</dt>
        <dd>{agent.vault || "none"}</dd>
        <dt>Donated</dt>
        <dd>
          {usdcText(agent.totals?.donated ?? "0")} in {agent.totals?.donations ?? 0} donations
        </dd>
        <dt>Given</dt>
        <dd>
          {usdcText(agent.totals?.given ?? "0")} in {agent.totals?.gifts ?? 0} gifts
        </dd>
      </dl>
    </section>
  );
}

function ReportSection({
  agent,
  report,
  loading,
  error,
  epoch,
  region,
  root,
}: {
  agent: AgentInfo;
  report: AgentReport | null;
  loading: boolean;
  error: unknown;
  epoch: string | null;
  region?: string;
  root: string;
}) {
  const regions = [...(report?.regions ?? [])].sort((a, b) => (REGION_ORDER.get(a.region) ?? 99) - (REGION_ORDER.get(b.region) ?? 99));
  return (
    <section aria-label="Report">
      <h2>{epoch === null ? "Weekly report" : `Report for epoch ${epoch}`}</h2>
      {epoch === null && <p>No report published yet.</p>}
      {loading && <p role="status">Loading report</p>}
      {Boolean(error) && <p role="alert">Could not load the report: {errorText(error)}</p>}
      {epoch !== null && !loading && !error && !report && <p role="alert">The report for epoch {epoch} is not available.</p>}
      {report && (
        <>
          {report.title && <h3>{report.title}</h3>}
          {report.generatedAt && <p>Written {report.generatedAt}. Catalogue version {report.catalogVersion}.</p>}
          {/* Under the report's own heading (the title's h3, or the section's h2): intro headings start at h4. */}
          {report.intro && <Markdown source={report.intro} baseLevel={3} />}
          <RegionLinks label={agent.label} current={region} root={root} />
          {region ? <FocusedRegion report={report} region={region} /> : <RegionTabs regions={regions} label={agent.label} root={root} />}
        </>
      )}
    </section>
  );
}

/** Links to the per-region pages. */
function RegionLinks({ label, current, root }: { label: string; current?: string; root: string }) {
  return (
    <nav aria-label="Regions">
      {current ? <a href={agentHref(root, label)}>All regions</a> : <span>All regions</span>}
      {REGIONS.map((r) => (
        <span key={r.slug}>
          {" | "}
          {r.slug === current ? (
            <span aria-current="page">{r.label}</span>
          ) : (
            <a href={agentHref(root, label, r.slug)}>{r.label}</a>
          )}
        </span>
      ))}
    </nav>
  );
}

function FocusedRegion({ report, region }: { report: AgentReport; region: string }) {
  const r = regionReport(report, region);
  if (!r) return <p>The agent published nothing for {regionName(region)} this week.</p>;
  return <AgentRegionView region={r} headingLevel={3} />;
}

/** WAI-ARIA tabs with automatic activation: roving tabIndex, arrows / Home / End move focus and selection. */
function RegionTabs({ regions, label, root }: { regions: AgentReport["regions"]; label: string; root: string }) {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (regions.length === 0) return <p>This report has no regions.</p>;
  const index = Math.min(selected, regions.length - 1);
  const current = regions[index]!;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const last = regions.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label="Report regions">
        {regions.map((r, i) => (
          <button
            key={r.region}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`region-tab-${r.region}`}
            aria-selected={i === index}
            aria-controls="region-panel"
            tabIndex={i === index ? 0 : -1}
            onClick={() => setSelected(i)}
            onKeyDown={onKeyDown}
          >
            {regionName(r.region)} ({r.picks.length})
          </button>
        ))}
      </div>
      <div role="tabpanel" id="region-panel" aria-labelledby={`region-tab-${current.region}`} tabIndex={0}>
        <AgentRegionView region={current} headingLevel={3} />
        <p>
          <a href={agentHref(root, label, current.region)}>Open the {regionName(current.region)} page</a>
        </p>
      </div>
    </>
  );
}

function ReportArchive({ agent, epoch, onChoose }: { agent: AgentInfo; epoch: string | null; onChoose: (e: string) => void }) {
  return (
    <section aria-label="Report archive">
      <h2>Report archive</h2>
      {agent.reports.length === 0 ? (
        <p>No reports yet.</p>
      ) : (
        <ul>
          {agent.reports.map((r) => (
            <li key={r.epoch}>
              <button type="button" aria-pressed={r.epoch === epoch} onClick={() => onChoose(r.epoch)}>
                Epoch {r.epoch}
              </button>{" "}
              {r.submittedAt !== undefined && `submitted ${formatTime(r.submittedAt)}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Donations whose donors opted in to public credit. Anonymous donations never show an address. */
function CreditedDonors({ agent }: { agent: AgentInfo }) {
  const credited = agent.donors.filter((d): d is typeof d & { donor: string } => typeof d.donor === "string" && d.donor !== "");
  return (
    <section aria-label="Credited donors">
      <h2>Credited donors</h2>
      <p>Only donors who chose public credit are listed. Anonymous donations count in the totals above.</p>
      {credited.length === 0 ? (
        <p>No credited donors yet.</p>
      ) : (
        <ul>
          {credited.map((d) => (
            <li key={`${d.txHash}-${d.donor}`}>
              {d.donor}: {usdcText(d.amount)}
              {d.timestamp !== undefined && ` (${formatTime(d.timestamp)})`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentGifts({ agent, report }: { agent: AgentInfo; report: AgentReport | null }) {
  const names = new Map<string, string>();
  for (const r of report?.regions ?? []) for (const p of r.picks) names.set(p.orgId.toLowerCase(), p.name);
  return (
    <section aria-label="Recent gifts">
      <h2>Recent gifts</h2>
      {agent.gifts.length === 0 ? (
        <p>No gifts yet.</p>
      ) : (
        <ul>
          {agent.gifts.map((g) => (
            <li key={g.id || g.txHash}>
              {usdcText(g.amount)} to {names.get(g.orgId.toLowerCase()) ?? shortAddress(g.org)} ({regionName(g.region)}, epoch {g.epoch}
              {g.timestamp !== undefined && `, ${formatTime(g.timestamp)}`})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
