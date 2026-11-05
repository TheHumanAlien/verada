import type { Address, Hex } from "viem";

/** Decoded event payloads. Names match the on-chain events exactly. */

export interface TokenCreatedEvent {
  token: Address;
  creator: Address;
  pool: Hex;
  hook: Address;
  lpTokenId: bigint;
  feeBps: number;
  metadataURI: string;
}

/** Emitted by the fee vault. `currency` is the settlement asset (USDC), amounts have 6 decimals. */
export interface FeesCollectedEvent {
  token: Address;
  platformAmount: bigint;
  causeAmount: bigint;
  currency: Address;
}

/**
 * Emitted once per non-zero part of a deposit: `causeAmount` of the fees earned in
 * `accrualEpoch` was credited to the cause pool of `epoch` (the accrual epoch, or the first
 * unsettled epoch after it). The parts of one deposit sum to that deposit's
 * `FeesCollected.causeAmount`.
 */
export interface FeesAttributedEvent {
  token: Address;
  epoch: bigint;
  accrualEpoch: bigint;
  causeAmount: bigint;
}

/** `payout` is the nonprofit org's deterministic (CREATE2) address, deployed or not. */
export interface CauseAddedEvent {
  causeId: Hex;
  payout: Address;
}

export interface PayoutUpdatedEvent {
  causeId: Hex;
  oldPayout: Address;
  newPayout: Address;
}

export interface CauseDeactivatedEvent {
  causeId: Hex;
}

export interface EpochFinalizedEvent {
  token: Address;
  epoch: bigint;
  causeId: Hex;
}

export interface DonatedEvent {
  token: Address;
  epoch: bigint;
  causeId: Hex;
  payout: Address;
  amount: bigint;
}

/** `voteRef` is opaque so a private voting scheme can replace it. */
export interface VoteCastEvent {
  token: Address;
  epoch: bigint;
  voteRef: Hex;
}

/** Fee consolidator: collected fees swapped into the settlement asset. */
export interface FeesConsolidatedEvent {
  token: Address;
  currencyIn: Address;
  amountIn: bigint;
  settlementOut: bigint;
}

/** Fee consolidator: the route failed, fees are held for retry (the caller does not revert). */
export interface ConsolidationFailedEvent {
  token: Address;
  currencyIn: Address;
  amountIn: bigint;
  reason: Hex;
}

export interface MaxSlippageBpsUpdatedEvent {
  maxSlippageBps: bigint;
}

/** Quote registry events. `kind`: 0 = Native (WETH), 1 = Ondo. */
export interface QuoteAssetAddedEvent {
  asset: Address;
  decimals: number;
  kind: number;
}

export interface QuoteAssetDeactivatedEvent {
  asset: Address;
}

export interface QuoteAssetReactivatedEvent {
  asset: Address;
}

export interface OrgDeployedEvent {
  orgId: Hex;
  org: Address;
}

export interface VeradaEventMap {
  TokenCreated: TokenCreatedEvent;
  FeesCollected: FeesCollectedEvent;
  FeesAttributed: FeesAttributedEvent;
  CauseAdded: CauseAddedEvent;
  CauseDeactivated: CauseDeactivatedEvent;
  EpochFinalized: EpochFinalizedEvent;
  Donated: DonatedEvent;
  VoteCast: VoteCastEvent;
  PayoutUpdated: PayoutUpdatedEvent;
  FeesConsolidated: FeesConsolidatedEvent;
  ConsolidationFailed: ConsolidationFailedEvent;
  MaxSlippageBpsUpdated: MaxSlippageBpsUpdatedEvent;
  QuoteAssetAdded: QuoteAssetAddedEvent;
  QuoteAssetDeactivated: QuoteAssetDeactivatedEvent;
  QuoteAssetReactivated: QuoteAssetReactivatedEvent;
  OrgDeployed: OrgDeployedEvent;
  TokenRegistered: TokenRegisteredEvent;
  ControllerChanged: ControllerChangedEvent;
  EditorChanged: EditorChangedEvent;
  TextChanged: TextChangedEvent;
  ContenthashChanged: ContenthashChangedEvent;
  LogoChanged: LogoChangedEvent;
  SuppressionChanged: SuppressionChangedEvent;
  EpochOpened: EpochOpenedEvent;
  EpochClosed: EpochClosedEvent;
  ShortlistUpdated: ShortlistUpdatedEvent;
  PollOpened: PollOpenedEvent;
  BallotCast: BallotCastEvent;
  TallyRequested: TallyRequestedEvent;
  TallySubmitted: TallySubmittedEvent;
  TakeoverProposed: TakeoverProposedEvent;
  TakeoverVoteCast: TakeoverVoteCastEvent;
  TakeoverClosed: TakeoverClosedEvent;
  TakeoverTallied: TakeoverTalliedEvent;
  TakeoverExecuted: TakeoverExecutedEvent;
  TakeoverCanceled: TakeoverCanceledEvent;
}

/** Numeric values of the on-chain `QuoteRegistry.Kind` enum. */
export const QUOTE_KIND = { Native: 0, Ondo: 1 } as const;

export type VeradaEventName = keyof VeradaEventMap;

// ---------------------------------------------------------------- token profiles (ENS subnames)

/** Emitted by the profile registry when the factory registers a launched token's label. */
export interface TokenRegisteredEvent {
  token: Address;
  labelhash: Hex;
  label: string;
  controller: Address;
  logoRef: Hex;
}

export interface ControllerChangedEvent {
  token: Address;
  previousController: Address;
  newController: Address;
}

export interface EditorChangedEvent {
  token: Address;
  editor: Address;
}

/** `indexedKey` is the keccak of `key` (indexed string); `key` is the plain record key. */
export interface TextChangedEvent {
  token: Address;
  indexedKey: Hex;
  key: string;
  value: string;
}

export interface ContenthashChangedEvent {
  token: Address;
  hash: Hex;
}

export interface LogoChangedEvent {
  token: Address;
  logoRef: Hex;
}

export interface SuppressionChangedEvent {
  token: Address;
  suppressed: boolean;
}

// ---------------------------------------------------------------- governance (epochs)

/** Options frozen for an epoch, in ballot order. */
export interface EpochOpenedEvent {
  token: Address;
  epoch: bigint;
  options: Hex[];
}

export interface EpochClosedEvent {
  token: Address;
  epoch: bigint;
}

export interface ShortlistUpdatedEvent {
  token: Address;
  causeIds: Hex[];
}

// ---------------------------------------------------------------- voting scheme polls

export interface PollOpenedEvent {
  governor: Address;
  token: Address;
  scope: bigint;
  optionCount: number;
}

export interface BallotCastEvent {
  governor: Address;
  token: Address;
  scope: bigint;
  voter: Address;
  weight: bigint;
  ballotRef: Hex;
}

export interface TallyRequestedEvent {
  governor: Address;
  token: Address;
  scope: bigint;
}

export interface TallySubmittedEvent {
  governor: Address;
  token: Address;
  scope: bigint;
  counts: bigint[];
}

// ---------------------------------------------------------------- community takeover

export interface TakeoverProposedEvent {
  token: Address;
  proposalId: bigint;
  proposer: Address;
  newController: Address;
  start: bigint;
  end: bigint;
  quorumWeight: bigint;
}

export interface TakeoverVoteCastEvent {
  token: Address;
  proposalId: bigint;
  voteRef: Hex;
}

export interface TakeoverClosedEvent {
  token: Address;
  proposalId: bigint;
}

export interface TakeoverTalliedEvent {
  token: Address;
  proposalId: bigint;
  forWeight: bigint;
  againstWeight: bigint;
}

export interface TakeoverExecutedEvent {
  token: Address;
  proposalId: bigint;
  newController: Address;
}

export interface TakeoverCanceledEvent {
  token: Address;
  proposalId: bigint;
}
