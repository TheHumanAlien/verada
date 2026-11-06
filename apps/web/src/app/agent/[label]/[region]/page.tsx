import { notFound } from "next/navigation";
import { AGENT_CATEGORIES, REGIONS, agentByLabel } from "@verada/sdk";
import { AgentDetail } from "@/components/agent-detail";

// Static export: every agent x region, and nothing else.
export const dynamicParams = false;

export function generateStaticParams(): { label: string; region: string }[] {
  return AGENT_CATEGORIES.flatMap((c) => REGIONS.map((r) => ({ label: c.ensLabel, region: r.slug })));
}

export default async function AgentRegionPage({ params }: { params: Promise<{ label: string; region: string }> }) {
  const { label, region } = await params;
  const def = agentByLabel(label);
  if (!def || !REGIONS.some((r) => r.slug === region)) notFound();
  return <AgentDetail label={def.ensLabel} region={region} root="../../../" />;
}
