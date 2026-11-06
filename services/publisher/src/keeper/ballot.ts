/**
 * Ballot preparation lives in the SDK (`planBallotOpening`), shared with the web app's "Open this
 * week's ballot" button, so a volunteer and the keeper build the exact same transaction.
 */
export {
  CatalogMismatch,
  createBallotPreparer,
  CuratedPicksUnavailable,
  type BallotPreparer,
  type BallotReader,
  type CatalogEntrySource,
  type EntryWithProof,
  type PickSource,
  type PickWithProof,
} from "@verada/sdk";
