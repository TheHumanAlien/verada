import { ponder } from "ponder:registry";
import { onCauseAdded, onCauseDeactivated, onPayoutUpdated } from "./handlers/causes";
import { onConsolidationFailed, onFeesCollected, onFeesConsolidated } from "./handlers/fees";
import { onCatalogVersionSet, onFocusSet } from "./handlers/catalog";
import {
  onBallotPrepared,
  onDonated,
  onEpochCloseFailed,
  onEpochClosed,
  onEpochFinalized,
  onEpochOpened,
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
ponder.on("FeeVault:FeesCollected", onFeesCollected);
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
ponder.on("EpochGovernor:BallotPrepared", onBallotPrepared);
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
