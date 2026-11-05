import type { Hex } from "viem";
import {
  type ActivityItem,
  type CausePoolAttributionRow,
  type CauseRow,
  type DonationRow,
  type EpochClock,
  type EpochRow,
  type FeeTotalRow,
  type PollRow,
  type Repo,
  type ShortlistSchedule,
  type TakeoverRow,
  type TextRecordRow,
  type TokenRow,
  activityCursor,
  isNewer,
  tieMode,
} from "../src/api/types";

export const T1 = "0x00000000000000000000000000000000000000a1" as Hex;
export const T2 = "0x00000000000000000000000000000000000000a2" as Hex;
export const T3 = "0x00000000000000000000000000000000000000a3" as Hex;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ADDR = "0x00000000000000000000000000000000000000c1" as Hex;
export const GOV = "0x00000000000000000000000000000000000000e1" as Hex;
export const TAKEOVER = "0x00000000000000000000000000000000000000e2" as Hex;
export const SCHEME = "0x00000000000000000000000000000000000000e3" as Hex;
export const NEW_CONTROLLER = "0x00000000000000000000000000000000000000c2" as Hex;
export const WEEK = 604_800n;
export const EPOCH_ZERO = 2900n * WEEK;
/** T1's launch-epoch snapshot, a day into epoch 0. */
export const LAUNCH_SNAPSHOT = EPOCH_ZERO + 86_400n;

const LABELS = ["alpha", "beta", null] as const;

export const tokens: TokenRow[] = [T1, T2, T3].map((address, i) => ({
  address,
  creator: ADDR,
  pool: ADDR,
  hook: ADDR,
  lpTokenId: BigInt(i + 1),
  feeBps: 300,
  metadataUri: `bzz://meta-${i}`,
  createdAt: BigInt(1000 + i * 10),
  createdBlock: BigInt(100 + i),
  txHash: H(i + 1),
  name: `Token ${i}`,
  symbol: `TK${i}`,
  label: LABELS[i] ?? null,
  labelhash: LABELS[i] ? H(0x100 + i) : null,
  controller: LABELS[i] ? ADDR : null,
  editor: i === 0 ? NEW_CONTROLLER : null,
  logoRef: i === 0 ? H(0x200) : null,
  contenthash: i === 0 ? ("0xe301" as Hex) : null,
  suppressed: i === 1,
  registeredAt: LABELS[i] ? BigInt(1000 + i * 10) : null,
  categoryMask: i === 0 ? 12n : null,
  regionMask: i === 0 ? 3 : null,
}));

export const textRecords: Record<Hex, TextRecordRow[]> = {
  [T1]: [
    { key: "com.twitter", value: "alpha" },
    { key: "url", value: "https://alpha.example" },
  ],
};

// "Now" for the fixtures is epoch 5. T1 has a list in effect and a pending change from epoch 6;
// T2 cleared its pins (empty, in effect).
export const NOW_EPOCH = 5n;
export const shortlists: Record<Hex, ShortlistSchedule> = {
  [T1]: { causeIds: [H(0x13)], effectiveFrom: 6n, previousCauseIds: [H(0x11), H(0x12)] },
  [T2]: { causeIds: [], effectiveFrom: 3n, previousCauseIds: [H(0x11)] },
};
/** T1 focuses on hunger and children in Africa and Asia. */
export const focus = { [T1]: { categoryMask: (1n << 2n) | (1n << 3n), regionMask: 0b11 } } as Record<Hex, { categoryMask: bigint; regionMask: number }>;
export const clock: EpochClock = { epochZeroStart: EPOCH_ZERO, epochLength: WEEK };

export const polls: PollRow[] = [
  {
    governor: GOV,
    token: T1,
    scope: 2n,
    scheme: SCHEME,
    optionCount: 2,
    opened: true,
    closed: true,
    isFinal: true,
    ballotCount: 3,
    counts: [12n, 30n],
    openedAt: 2100n,
    closedAt: 2190n,
    finalAt: 2195n,
  },
  {
    governor: TAKEOVER,
    token: T1,
    scope: 1n,
    scheme: SCHEME,
    optionCount: 2,
    opened: true,
    closed: false,
    isFinal: false,
    ballotCount: 1,
    counts: null,
    openedAt: 3000n,
    closedAt: null,
    finalAt: null,
  },
];

export const epochOptions: Record<string, Hex[]> = { [`${T1}:2`]: [H(0x11), H(0x12)] };

const proposal = (id: bigint, over: Partial<TakeoverRow> = {}): TakeoverRow => ({
  proposalId: id,
  token: T1,
  proposer: ADDR,
  newController: NEW_CONTROLLER,
  start: 3000n,
  end: 4000n,
  snapshot: 2999n,
  executionDeadline: 5000n,
  lookbackSnapshot: 2000n,
  circulatingWeight: 1_000n,
  quorumWeight: 100n,
  forWeight: 0n,
  againstWeight: 0n,
  ballotCount: 0,
  closed: false,
  tallied: false,
  executed: false,
  canceled: false,
  createdAt: 3000n,
  closedAt: null,
  talliedAt: null,
  executedAt: null,
  canceledAt: null,
  txHash: H(0x300),
  generation: 0,
  ...over,
});

// T2's proposal 5 executed (one execution), superseding its still-pending proposal 2 and
// proposal 6, which was created after 5 but before 5 executed. Proposal 7 came after.
export const takeovers: TakeoverRow[] = [
  proposal(1n, { ballotCount: 1 }),
  proposal(2n, { token: T2 }),
  proposal(3n, { start: 6000n, end: 7000n, snapshot: 5999n, executionDeadline: 8000n, createdAt: 6000n }),
  proposal(5n, { token: T2, closed: true, tallied: true, forWeight: 500n, executed: true, executedAt: 4500n }),
  proposal(6n, { token: T2 }),
  proposal(7n, { token: T2, generation: 1, start: 4600n, end: 9000n, executionDeadline: 9900n }),
];
export const takeoverExecutions: Record<Hex, number> = { [T2]: 1 };

export const feeTotals: FeeTotalRow[] = [
  {
    token: T1,
    settlementAsset: ADDR,
    platformAmount: 10_000_000n,
    causeAmount: 90_000_000n,
    collections: 2,
    lastCollectedAt: 1500n,
  },
];

export const causes: CauseRow[] = [
  { causeId: H(0x11), payout: ADDR, active: true, addedAt: 900n, deactivatedAt: null },
];

export const epochs: EpochRow[] = [0n, 1n, 2n].map((e) => ({
  token: T1,
  epoch: e,
  winningCauseId: H(0x11),
  finalizedAt: 2000n + e * 100n,
  voteCount: Number(e) + 1,
  donatedAmount: e === 0n ? 5_000_000n : null,
  donatedPayout: e === 0n ? ADDR : null,
  donatedAt: e === 0n ? 2050n : null,
  opened: e === 2n,
  openedAt: e === 2n ? 2100n : null,
  closed: e === 2n,
  closedAt: e === 2n ? 2190n : null,
  voterCount: Number(e) + 1,
  fallbackApplied: e === 1n,
  fallbackReason: e === 1n ? "timeout" : null,
  closeFailed: false,
  governor: e === 2n ? GOV : null,
  scheme: e === 2n ? SCHEME : null,
  prepared: e === 2n,
  preparedAt: e === 2n ? 2100n : null,
  catalogVersion: e === 2n ? 1 : null,
  poolSize: e === 2n ? 120n : null,
  pinnedCount: e === 2n ? 1 : null,
  // Epoch 0 is T1's launch epoch: registered without supply at the regular snapshot.
  launchSnapshot: e === 0n ? LAUNCH_SNAPSHOT : null,
  causeAttributed: [5_000_000n, 40_000_000n, 45_000_000n][Number(e)]!,
  settledAmount: e === 0n ? 5_000_000n : null,
  settledAt: e === 0n ? 2040n : null,
}));


const attribution = (
  epoch: bigint,
  accrualEpoch: bigint,
  causeAmount: bigint,
  parts = 1,
): CausePoolAttributionRow => ({
  token: T1,
  epoch,
  accrualEpoch,
  causeAmount,
  parts,
  firstAttributedAt: 1500n,
  lastAttributedAt: 1500n,
});

// Epoch 0 settled with 5 USDC; 10 USDC more earned in epoch 0 arrived after that and went to
// epoch 1's pool. The cause amounts sum to the T1 fee total (90 USDC).
export const attributions: CausePoolAttributionRow[] = [
  attribution(0n, 0n, 5_000_000n),
  attribution(1n, 0n, 10_000_000n),
  attribution(1n, 1n, 30_000_000n, 2),
  attribution(2n, 2n, 45_000_000n),
];

export const donations: DonationRow[] = [
  {
    id: "d1",
    token: T1,
    epoch: 0n,
    causeId: H(0x11),
    payout: ADDR,
    amount: 5_000_000n,
    timestamp: 2050n,
    txHash: H(9),
  },
];

const item = (
  kind: ActivityItem["kind"],
  key: string,
  timestamp: number,
  token: Hex,
  data: Record<string, unknown> = {},
): ActivityItem => ({
  id: `${kind}:${key}`,
  kind,
  timestamp: BigInt(timestamp),
  token,
  txHash: H(timestamp),
  data,
});

export const activity: ActivityItem[] = [
  ...tokens.map((t) => item("launch", t.address, Number(t.createdAt), t.address)),
  item("fees", "f1", 1500, T1, { platformAmount: 1n, causeAmount: 9n }),
  item("fees", "f2", 1600, T2, { platformAmount: 2n, causeAmount: 18n }),
  item("consolidated", "c1", 1600, T1, { settlementOut: 7n }),
  item("vote", "v1", 1700, T1, { epoch: 0n }),
  item("vote", "v2", 1700, T1, { epoch: 0n }),
  item("donation", "d1", 2050, T1, { amount: 5_000_000n }),
  item("epoch", `${T1}:0`, 2000, T1, { epoch: 0n }),
  item("token_registered", T1, 1000, T1, { label: "alpha" }),
  item("token_registered", T2, 1010, T2, { label: "beta" }),
  item("profile_updated", "p1", 1700, T1, { field: "text", key: "url", value: "https://alpha.example" }),
  item("epoch_opened", `${T1}:2`, 2100, T1, { epoch: 2n }),
  item("epoch_closed", `${T1}:2`, 2190, T1, { epoch: 2n, voterCount: 3 }),
  item("tally_submitted", `${GOV}:${T1}:2`, 2195, T1, { scope: 2n, counts: [12n, 30n] }),
  item("takeover_proposed", "1", 3000, T1, { proposalId: 1n }),
  item("takeover_executed", "9", 3000, T2, { proposalId: 9n }),
].sort((a, b) =>
  a.timestamp !== b.timestamp ? (a.timestamp > b.timestamp ? -1 : 1) : a.id > b.id ? -1 : 1,
);

/** In-memory Repo that applies the same cursor and tie rules as the SQL implementation. */
export function fixtureRepo(items: ActivityItem[] = activity): Repo {
  return {
    async listTokens({ before, limit }) {
      return [...tokens]
        .sort((a, b) =>
          a.createdAt !== b.createdAt ? (a.createdAt > b.createdAt ? -1 : 1) : a.address > b.address ? -1 : 1,
        )
        .filter(
          (t) =>
            !before ||
            t.createdAt < BigInt(before.t) ||
            (t.createdAt === BigInt(before.t) && t.address < before.k),
        )
        .slice(0, limit);
    },
    async getToken(address) {
      const token = tokens.find((t) => t.address === address);
      if (!token) return null;
      return {
        token,
        feeTotals: feeTotals.find((f) => f.token === address) ?? null,
        textRecords: textRecords[address] ?? [],
        shortlist: shortlists[address] ?? null,
        focus: focus[address] ?? null,
        clock,
      };
    },
    async findTokenByLabel(label) {
      return tokens.find((t) => t.label === label)?.address ?? null;
    },
    async feeTotalsFor(addresses) {
      return feeTotals.filter((f) => addresses.includes(f.token));
    },
    async listActivity({ kinds, token, before, limit }) {
      return items
        .filter((i) => (!kinds || kinds.includes(i.kind)) && (!token || i.token === token))
        .filter((i) => {
          if (!before) return true;
          const ts = BigInt(before.t);
          if (i.timestamp !== ts) return i.timestamp < ts;
          const sep = before.k.indexOf(":");
          const mode = tieMode(i.kind, before.k.slice(0, sep));
          return mode === "all" || (mode === "byKey" && i.id < before.k);
        })
        .slice(0, limit);
    },
    async listCauses() {
      return causes;
    },
    async listEpochs(token, { before, limit }) {
      return epochs
        .filter((e) => e.token === token && (before === undefined || e.epoch < before))
        .sort((a, b) => (a.epoch > b.epoch ? -1 : 1))
        .slice(0, limit);
    },
    async getEpoch(token, n) {
      const epoch = epochs.find((e) => e.token === token && e.epoch === n);
      if (!epoch) return null;
      return {
        epoch,
        donations: donations.filter((d) => d.token === token && d.epoch === n),
        options: epochOptions[`${token}:${n}`] ?? [],
        poll: polls.find((p) => p.governor === epoch.governor && p.token === token && p.scope === n) ?? null,
        clock,
        causePool: attributions
          .filter((a) => a.token === token && a.epoch === n)
          .sort((a, b) => (a.accrualEpoch < b.accrualEpoch ? -1 : 1)),
        accrued: attributions
          .filter((a) => a.token === token && a.accrualEpoch === n)
          .sort((a, b) => (a.epoch < b.epoch ? -1 : 1)),
      };
    },
    async listTakeovers(token, limit) {
      return takeovers
        .filter((p) => p.token === token)
        .sort((a, b) => (a.proposalId > b.proposalId ? -1 : 1))
        .slice(0, limit);
    },
    async getTakeover(id) {
      return takeovers.find((p) => p.proposalId === id) ?? null;
    },
    async takeoverExecutions(token) {
      return takeoverExecutions[token] ?? 0;
    },
    async getPoll(governor, token, scope) {
      return polls.find((p) => p.governor === governor && p.token === token && p.scope === scope) ?? null;
    },
    async stats() {
      return {
        tokens: tokens.length,
        platformFees: 10_000_000n,
        causeFees: 90_000_000n,
        consolidatedUsdc: 7n,
        donatedUsdc: 5_000_000n,
        donations: 1,
        votes: 2,
        epochsFinalized: 3,
        causes: 1,
      };
    },
  };
}

export { activityCursor, isNewer };
