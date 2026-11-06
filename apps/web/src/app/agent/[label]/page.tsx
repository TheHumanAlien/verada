import { notFound } from "next/navigation";
import { AGENT_CATEGORIES, agentByLabel } from "@verada/sdk";
import { AgentDetail } from "@/components/agent-detail";

// Static export: one page per agent, and nothing else under agent/.
export const dynamicParams = false;

export function generateStaticParams(): { label: string }[] {
  return AGENT_CATEGORIES.map((c) => ({ label: c.ensLabel }));
}

export default async function AgentLabelPage({ params }: { params: Promise<{ label: string }> }) {
  const { label } = await params;
  const def = agentByLabel(label);
  if (!def) notFound();
  return <AgentDetail label={def.ensLabel} root="../../" />;
}
