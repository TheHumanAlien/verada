import type { Hex } from "viem";
import {
  type ActivityItem,
  type CauseRow,
  type DonationRow,
  type EpochRow,
  type FeeTotalRow,
  type Repo,
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
}));

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
}));

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
      return token ? { token, feeTotals: feeTotals.find((f) => f.token === address) ?? null } : null;
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
      return epoch ? { epoch, donations: donations.filter((d) => d.token === token && d.epoch === n) } : null;
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
