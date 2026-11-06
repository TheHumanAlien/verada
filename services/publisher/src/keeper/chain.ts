import type { Address, Hex } from "viem";

/** `ITakeoverGovernor.State`, in enum order. */
export const PROPOSAL_STATES = ["None", "Active", "Closing", "Defeated", "Succeeded", "Executed", "Canceled", "Expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** States a proposal never leaves, so the keeper can stop reading it. */
export const TERMINAL_PROPOSAL_STATES: readonly ProposalState[] = ["Defeated", "Executed", "Canceled", "Expired"];

/** `EpochGovernor` state of one `(token, epoch)`. `scheme` is zero until the epoch opens. */
export interface EpochView {
  opened: boolean;
  closed: boolean;
  finalized: boolean;
  voterCount: bigint;
  scheme: Address;
}

/** `IVotingScheme.tallyOf`. */
export interface Tally {
  isFinal: boolean;
  counts: readonly bigint[];
}

/** `TakeoverGovernor` state of one proposal. */
export interface ProposalView {
  token: Address;
  state: ProposalState;
  closed: boolean;
  tallied: boolean;
  scheme: Address;
}

/** Contract reads the keeper bases every decision on. */
export interface ChainReader {
  currentEpoch(): Promise<bigint>;
  /** `EpochGovernor.epochStart`, in seconds. */
  epochStart(epoch: bigint): Promise<bigint>;
  isRegistered(token: Address): Promise<boolean>;
  epoch(token: Address, epoch: bigint): Promise<EpochView>;
  tallyOf(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<Tally>;
  tallyHandles(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<readonly Hex[]>;
  /**
   * Catalogue org ids of an epoch's ballot, in order, from its `BallotPrepared` log. The governor
   * keeps only their commitment, so finalizing an epoch with ballots passes them back as calldata.
   */
  ballotOrgIds(token: Address, epoch: bigint): Promise<Hex[]>;
  proposalCount(): Promise<bigint>;
  proposal(id: bigint): Promise<ProposalView>;
  /**
   * LP fees the token's locked position has earned but nobody has collected yet (both currencies'
   * raw amounts added; a simulated `VeradaLpLocker.collectFees`). Trading fees only reach the
   * FeeVault, and the indexer, when someone collects them. Omitted when the locker is unknown.
   */
  uncollectedFees?(token: Address): Promise<bigint>;
}

/** A permissionless transaction the keeper may send. */
export type KeeperAction =
  | { kind: "openEpoch"; token: Address; epoch: bigint }
  | { kind: "requestCurationSkip"; token: Address; epoch: bigint }
  | { kind: "closeEpoch"; token: Address; epoch: bigint }
  /** `orgIds`: the ballot's org ids when the epoch has ballots (checked against its commitment), else empty. */
  | { kind: "finalizeEpoch"; token: Address; epoch: bigint; orgIds: Hex[] }
  | { kind: "prepareBallot"; token: Address; epoch: bigint; draws: { orgId: Hex; proof: Hex[] }[] }
  | {
      kind: "prepareCuratedBallot";
      token: Address;
      epoch: bigint;
      curated: { catalogIndex: number; pickOrgId: Hex; pickProof: Hex[]; entryOrgId: Hex; entryProof: Hex[] }[];
      draws: { orgId: Hex; proof: Hex[] }[];
    }
  | { kind: "submitTally"; scheme: Address; governor: Address; token: Address; scope: bigint; cleartexts: Hex; proof: Hex }
  | { kind: "closeProposal"; id: bigint }
  | { kind: "recordTally"; id: bigint }
  | { kind: "execute"; id: bigint };

export interface TxResult {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
}

/** Signs and sends keeper transactions from one account, one at a time. */
export interface ChainWriter {
  readonly account: Address;
  /** Gas estimate; throws {@link KeeperRevert} when the call would revert. */
  estimate(action: KeeperAction): Promise<bigint>;
  /** Sends with the given gas limit and waits for the receipt. */
  send(action: KeeperAction, gas: bigint): Promise<TxResult>;
}

/** A call that would revert. `errorName` is the decoded custom error (arguments are dropped). */
export class KeeperRevert extends Error {
  constructor(
    readonly errorName: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "KeeperRevert";
  }
}

/** Reads `TokenCreated` logs of the factory, for discovery when the indexer is down. */
export interface FactoryLogReader {
  /** Tokens created in `[fromBlock, latest]` and the last block scanned. */
  tokensCreated(fromBlock: bigint): Promise<{ tokens: Address[]; toBlock: bigint }>;
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Strips URLs (RPC endpoints may carry keys) and addresses from an error message, and truncates it. */
export function redact(message: string, max = 300): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
    .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "<address>")
    .slice(0, max);
}
