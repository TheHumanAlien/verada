import type { Hex } from "viem";
import type { Cursor } from "./cursor";

export const ACTIVITY_KINDS = [
  "launch",
  "fees",
  "consolidated",
  "donation",
  "vote",
  "epoch",
  "token_registered",
  "profile_updated",
  "epoch_opened",
  "epoch_closed",
  "takeover_proposed",
  "takeover_executed",
  "tally_submitted",
] as const;
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
  name: string;
  symbol: string;
  label: string | null;
  labelhash: Hex | null;
  controller: Hex | null;
  editor: Hex | null;
  logoRef: Hex | null;
  contenthash: Hex | null;
  suppressed: boolean;
  registeredAt: bigint | null;
  categoryMask: bigint | null;
  regionMask: number | null;
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
  opened: boolean;
  openedAt: bigint | null;
  closed: boolean;
  closedAt: bigint | null;
  voterCount: number;
  fallbackApplied: boolean;
  /** `no_votes` or `timeout` once a fallback applied. */
  fallbackReason: string | null;
  closeFailed: boolean;
  governor: Hex | null;
  scheme: Hex | null;
  /** Ballot fixed (`BallotPrepared`); options may be fewer than two, then it never opens. */
  prepared: boolean;
  preparedAt: bigint | null;
  catalogVersion: number | null;
  poolSize: bigint | null;
  pinnedCount: number | null;
}

/** A token's cause focus (`TokenProfileRegistry.FocusSet`). */
export interface FocusRow {
  categoryMask: bigint;
  regionMask: number;
}

export interface EpochClock {
  epochZeroStart: bigint;
  epochLength: bigint;
}

export interface PollRow {
  governor: Hex;
  token: Hex;
  scope: bigint;
  scheme: Hex;
  optionCount: number;
  opened: boolean;
  closed: boolean;
  isFinal: boolean;
  ballotCount: number;
  counts: bigint[] | null;
  openedAt: bigint;
  closedAt: bigint | null;
  finalAt: bigint | null;
}

export interface TakeoverRow {
  proposalId: bigint;
  token: Hex;
  proposer: Hex;
  newController: Hex;
  start: bigint;
  end: bigint;
  snapshot: bigint;
  executionDeadline: bigint | null;
  lookbackSnapshot: bigint | null;
  circulatingWeight: bigint | null;
  quorumWeight: bigint;
  forWeight: bigint;
  againstWeight: bigint;
  ballotCount: number;
  closed: boolean;
  tallied: boolean;
  executed: boolean;
  canceled: boolean;
  createdAt: bigint;
  closedAt: bigint | null;
  talliedAt: bigint | null;
  executedAt: bigint | null;
  canceledAt: bigint | null;
  txHash: Hex;
  /** Token executions when created; behind `takeoverExecutions(token)` means superseded. */
  generation: number;
}

/** Stored shortlist schedule (see `ponder.schema.ts`). */
export interface ShortlistSchedule {
  causeIds: Hex[];
  effectiveFrom: bigint | null;
  previousCauseIds: Hex[];
}

export interface TextRecordRow {
  key: string;
  value: string;
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
  getToken(address: Hex): Promise<{
    token: TokenRow;
    feeTotals: FeeTotalRow | null;
    textRecords: TextRecordRow[];
    shortlist: ShortlistSchedule | null;
    focus: FocusRow | null;
    clock: EpochClock | null;
  } | null>;
  /** Address of the token registered under `label`, if any. */
  findTokenByLabel(label: string): Promise<Hex | null>;
  feeTotalsFor(addresses: Hex[]): Promise<FeeTotalRow[]>;
  listActivity(q: ActivityQuery): Promise<ActivityItem[]>;
  listCauses(): Promise<CauseRow[]>;
  /** Newest epoch first. */
  listEpochs(token: Hex, q: { before?: bigint; limit: number }): Promise<EpochRow[]>;
  getEpoch(token: Hex, epoch: bigint): Promise<{
    epoch: EpochRow;
    donations: DonationRow[];
    /** Frozen options by ballot index (empty until opened). */
    options: Hex[];
    poll: PollRow | null;
    clock: EpochClock | null;
  } | null>;
  /** Newest proposal first. */
  listTakeovers(token: Hex, limit: number): Promise<TakeoverRow[]>;
  getTakeover(proposalId: bigint): Promise<TakeoverRow | null>;
  /** Executed takeovers of `token` so far (0 when none). */
  takeoverExecutions(token: Hex): Promise<number>;
  getPoll(governor: Hex, token: Hex, scope: bigint): Promise<PollRow | null>;
  stats(): Promise<Stats>;
}
