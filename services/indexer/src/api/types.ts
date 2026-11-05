import type { Hex } from "viem";
import type { Cursor } from "./cursor";

export const ACTIVITY_KINDS = ["launch", "fees", "consolidated", "donation", "vote", "epoch"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  /** `<kind>:<row key>`; unique and totally ordered together with `timestamp`. */
  id: string;
  kind: ActivityKind;
  /** Unix seconds. */
  timestamp: bigint;
  token: Hex;
  txHash: Hex | null;
  data: Record<string, unknown>;
}

export const activityCursor = (i: Pick<ActivityItem, "timestamp" | "id">): Cursor => ({
  t: i.timestamp.toString(),
  k: i.id,
});

/** True when `a` sorts strictly newer than `b` (newest-first ordering). */
export function isNewer(a: Cursor, b: Cursor): boolean {
  const at = BigInt(a.t);
  const bt = BigInt(b.t);
  if (at !== bt) return at > bt;
  return a.k > b.k;
}

/**
 * How a table of kind `kind` relates to a cursor row of kind `cursorKind` among rows that share
 * the cursor timestamp: ids compare as `<kind>:<key>`, so differing kinds decide the order alone.
 */
export function tieMode(kind: string, cursorKind: string): "all" | "none" | "byKey" {
  if (kind === cursorKind) return "byKey";
  return kind < cursorKind ? "all" : "none";
}

export interface TokenRow {
  address: Hex;
  creator: Hex;
  pool: Hex;
  hook: Hex;
  lpTokenId: bigint;
  feeBps: number;
  metadataUri: string;
  createdAt: bigint;
  createdBlock: bigint;
  txHash: Hex;
}

export interface FeeTotalRow {
  token: Hex;
  settlementAsset: Hex;
  platformAmount: bigint;
  causeAmount: bigint;
  collections: number;
  lastCollectedAt: bigint;
}

export interface CauseRow {
  causeId: Hex;
  payout: Hex;
  active: boolean;
  addedAt: bigint;
  deactivatedAt: bigint | null;
}

export interface EpochRow {
  token: Hex;
  epoch: bigint;
  winningCauseId: Hex | null;
  finalizedAt: bigint | null;
  voteCount: number;
  donatedAmount: bigint | null;
  donatedPayout: Hex | null;
  donatedAt: bigint | null;
}

export interface DonationRow {
  id: string;
  token: Hex;
  epoch: bigint;
  causeId: Hex;
  payout: Hex;
  amount: bigint;
  timestamp: bigint;
  txHash: Hex;
}

export interface Stats {
  tokens: number;
  /** All amounts are USDC base units (6 decimals). */
  platformFees: bigint;
  causeFees: bigint;
  consolidatedUsdc: bigint;
  donatedUsdc: bigint;
  donations: number;
  votes: number;
  epochsFinalized: number;
  causes: number;
}

export interface ActivityQuery {
  kinds?: ActivityKind[];
  token?: Hex;
  before?: Cursor;
  /** Maximum rows to return (callers pass page size + 1). */
  limit: number;
}

/** Read-only data access used by the routes; implemented over Ponder's db and by test fixtures. */
export interface Repo {
  /** Newest first. */
  listTokens(q: { before?: Cursor; limit: number }): Promise<TokenRow[]>;
  getToken(address: Hex): Promise<{ token: TokenRow; feeTotals: FeeTotalRow | null } | null>;
  feeTotalsFor(addresses: Hex[]): Promise<FeeTotalRow[]>;
  listActivity(q: ActivityQuery): Promise<ActivityItem[]>;
  listCauses(): Promise<CauseRow[]>;
  /** Newest epoch first. */
  listEpochs(token: Hex, q: { before?: bigint; limit: number }): Promise<EpochRow[]>;
  getEpoch(token: Hex, epoch: bigint): Promise<{ epoch: EpochRow; donations: DonationRow[] } | null>;
  stats(): Promise<Stats>;
}
