import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { and, desc, eq } from "ponder";
import type { AgentsRepo } from "./agents";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { agent, agentTotal, curation, curationReport, vaultDonation, vaultGift } = schema;

export const agentsRepo: AgentsRepo = {
  async listAgents() {
    const agents = await db.select().from(agent).orderBy(agent.categoryBit);
    return Promise.all(
      agents.map(async (a) => {
        const [totals] = await db.select().from(agentTotal).where(eq(agentTotal.categoryBit, a.categoryBit)).limit(1);
        const [latest] = await db.select().from(curationReport).where(eq(curationReport.categoryBit, a.categoryBit)).orderBy(desc(curationReport.epoch)).limit(1);
        return { agent: a, totals: totals ?? null, latest: latest ?? null };
      }),
    );
  },
  async getAgentByLabel(label) {
    const [a] = await db.select().from(agent).where(eq(agent.label, label)).limit(1);
    return a ?? null;
  },
  async totals(categoryBit) {
    const [t] = await db.select().from(agentTotal).where(eq(agentTotal.categoryBit, categoryBit)).limit(1);
    return t ?? null;
  },
  async reports(categoryBit, limit) {
    return db.select().from(curationReport).where(eq(curationReport.categoryBit, categoryBit)).orderBy(desc(curationReport.epoch)).limit(limit);
  },
  async curations(categoryBit, epoch) {
    return db.select().from(curation).where(and(eq(curation.categoryBit, categoryBit), eq(curation.epoch, epoch)));
  },
  async creditedDonations(categoryBit, limit) {
    return db
      .select()
      .from(vaultDonation)
      .where(and(eq(vaultDonation.categoryBit, categoryBit), eq(vaultDonation.credit, true)))
      .orderBy(desc(vaultDonation.timestamp))
      .limit(limit);
  },
  async gifts(categoryBit, limit) {
    return db.select().from(vaultGift).where(eq(vaultGift.categoryBit, categoryBit)).orderBy(desc(vaultGift.timestamp)).limit(limit);
  },
};
