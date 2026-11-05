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
}

/** Numeric values of the on-chain `QuoteRegistry.Kind` enum. */
export const QUOTE_KIND = { Native: 0, Ondo: 1 } as const;

export type VeradaEventName = keyof VeradaEventMap;
