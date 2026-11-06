import { ponder } from "ponder:registry";
import { onCauseAdded, onCauseDeactivated, onPayoutUpdated } from "./handlers/causes";
import {
  onConsolidationFailed,
  onFeesAttributed,
  onFeesCollected,
  onFeesConsolidated,
  onSettled,
} from "./handlers/fees";
import {
  onActiveSet,
  onAgentRegistered,
  onAgentURISet,
  onAgentWalletLinked,
  onCurationSet,
  onCurationsSubmitted,
  onDescriptionSet,
  onSignerSet,
  onVaultDonated,
  onVaultGiven,
} from "./handlers/agents";
import { onCatalogVersionSet, onFocusSet } from "./handlers/catalog";
import {
  onBallotPrepared,
  onCuratedPicksUsed,
  onDonated,
  onEpochCloseFailed,
  onEpochClosed,
  onEpochFinalized,
  onEpochOpened,
  onLaunchSnapshotSet,
  onNoVoteFallbackApplied,
  onOrgDeployed,
  onShortlistScheduled,
  onShortlistSet,
  onTallyTimeoutFallbackApplied,
  onVoteCast,
} from "./handlers/governance";
import {
  onQuoteAssetAdded,
  onQuoteAssetDeactivated,
  onQuoteAssetReactivated,
} from "./handlers/quote";
import {
  onContenthashChanged,
  onControllerChanged,
  onEditorChanged,
  onLogoChanged,
  onSuppressionChanged,
  onTextChanged,
  onTokenRegistered,
} from "./handlers/registry";
import { onBallotCast, onPollOpened, onTallyRequested, onTallySubmitted } from "./handlers/scheme";
import {
  onTakeoverCanceled,
  onTakeoverClosed,
  onTakeoverExecuted,
  onTakeoverProposed,
  onTakeoverSuperseded,
  onTakeoverTallied,
  onTakeoverVoteCast,
} from "./handlers/takeover";
import { onTokenCreated } from "./handlers/token";

ponder.on("Factory:TokenCreated", onTokenCreated);
ponder.on("FeeVault:FeesAttributed", onFeesAttributed);
ponder.on("FeeVault:FeesCollected", onFeesCollected);
ponder.on("FeeVault:Settled", onSettled);
ponder.on("FeeConsolidator:FeesConsolidated", onFeesConsolidated);
ponder.on("FeeConsolidator:ConsolidationFailed", onConsolidationFailed);
ponder.on("QuoteRegistry:QuoteAssetAdded", onQuoteAssetAdded);
ponder.on("QuoteRegistry:QuoteAssetDeactivated", onQuoteAssetDeactivated);
ponder.on("QuoteRegistry:QuoteAssetReactivated", onQuoteAssetReactivated);
ponder.on("CauseRegistry:CauseAdded", onCauseAdded);
ponder.on("CauseRegistry:CauseDeactivated", onCauseDeactivated);
ponder.on("CauseRegistry:PayoutUpdated", onPayoutUpdated);
ponder.on("EpochGovernor:VoteCast", onVoteCast);
ponder.on("EpochGovernor:EpochOpened", onEpochOpened);
ponder.on("EpochGovernor:EpochClosed", onEpochClosed);
ponder.on("EpochGovernor:EpochCloseFailed", onEpochCloseFailed);
ponder.on("EpochGovernor:NoVoteFallbackApplied", onNoVoteFallbackApplied);
ponder.on("EpochGovernor:TallyTimeoutFallbackApplied", onTallyTimeoutFallbackApplied);
ponder.on("EpochGovernor:EpochFinalized", onEpochFinalized);
ponder.on("EpochGovernor:ShortlistSet", onShortlistSet);
ponder.on("EpochGovernor:ShortlistScheduled", onShortlistScheduled);
ponder.on("EpochGovernor:CuratedPicksUsed", onCuratedPicksUsed);
ponder.on("EpochGovernor:BallotPrepared", onBallotPrepared);
ponder.on("EpochGovernor:LaunchSnapshotSet", onLaunchSnapshotSet);
ponder.on("CauseCatalog:CatalogVersionSet", onCatalogVersionSet);
ponder.on("TokenProfileRegistry:FocusSet", onFocusSet);
ponder.on("DonationDistributor:Donated", onDonated);
ponder.on("DonationDistributor:OrgDeployed", onOrgDeployed);
ponder.on("TokenProfileRegistry:TokenRegistered", onTokenRegistered);
ponder.on("TokenProfileRegistry:ControllerChanged", onControllerChanged);
ponder.on("TokenProfileRegistry:EditorChanged", onEditorChanged);
ponder.on("TokenProfileRegistry:TextChanged", onTextChanged);
ponder.on("TokenProfileRegistry:ContenthashChanged", onContenthashChanged);
ponder.on("TokenProfileRegistry:LogoChanged", onLogoChanged);
ponder.on("TokenProfileRegistry:SuppressionChanged", onSuppressionChanged);
ponder.on("ZamaVotingScheme:PollOpened", onPollOpened);
ponder.on("ZamaVotingScheme:BallotCast", onBallotCast);
ponder.on("ZamaVotingScheme:TallyRequested", onTallyRequested);
ponder.on("ZamaVotingScheme:TallySubmitted", onTallySubmitted);
ponder.on("TakeoverGovernor:TakeoverProposed", onTakeoverProposed);
ponder.on("TakeoverGovernor:TakeoverVoteCast", onTakeoverVoteCast);
ponder.on("TakeoverGovernor:TakeoverClosed", onTakeoverClosed);
ponder.on("TakeoverGovernor:TakeoverTallied", onTakeoverTallied);
ponder.on("TakeoverGovernor:TakeoverExecuted", onTakeoverExecuted);
ponder.on("TakeoverGovernor:TakeoverCanceled", onTakeoverCanceled);
ponder.on("TakeoverGovernor:TakeoverSuperseded", onTakeoverSuperseded);
ponder.on("CuratorRegistry:AgentRegistered", onAgentRegistered);
ponder.on("CuratorRegistry:SignerSet", onSignerSet);
ponder.on("CuratorRegistry:ActiveSet", onActiveSet);
ponder.on("CuratorRegistry:DescriptionSet", onDescriptionSet);
ponder.on("CuratorRegistry:AgentURISet", onAgentURISet);
ponder.on("CuratorRegistry:AgentWalletLinked", onAgentWalletLinked);
ponder.on("CuratorRegistry:CurationSet", onCurationSet);
ponder.on("CuratorRegistry:CurationsSubmitted", onCurationsSubmitted);
ponder.on("AgentVault:Donated", onVaultDonated);
ponder.on("AgentVault:Given", onVaultGiven);
