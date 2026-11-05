import { ponder } from "ponder:registry";
import { onCauseAdded, onCauseDeactivated, onPayoutUpdated } from "./handlers/causes";
import { onConsolidationFailed, onFeesCollected, onFeesConsolidated } from "./handlers/fees";
import { onDonated, onEpochFinalized, onOrgDeployed, onVoteCast } from "./handlers/governance";
import {
  onQuoteAssetAdded,
  onQuoteAssetDeactivated,
  onQuoteAssetReactivated,
} from "./handlers/quote";
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
ponder.on("EpochGovernor:EpochFinalized", onEpochFinalized);
ponder.on("DonationDistributor:Donated", onDonated);
ponder.on("DonationDistributor:OrgDeployed", onOrgDeployed);
