# @verada/indexer

Ponder (^0.18) indexer for the Verada contracts on Ethereum mainnet, plus a read-only Hono API
for the browser. Bigints are returned as decimal strings, lists are cursor-paginated and every
`/api/*` response carries `Cache-Control` and a weak `ETag`.

```sh
cp .env.example .env.local   # fill in RPC, addresses and START_BLOCK
pnpm --filter @verada/indexer dev
pnpm --filter @verada/indexer test
pnpm --filter @verada/indexer typecheck
```

Ponder needs Node >= 22.12 (`codegen`, `dev`, `start`); the tests and typecheck do not.

## Environment

| Variable | Meaning |
| --- | --- |
| `PONDER_RPC_URL_1` | Mainnet RPC URL, or a comma-separated list Ponder load-balances across |
| `FACTORY_ADDRESS` | `VeradaFactory` |
| `FEE_VAULT_ADDRESS` | `FeeVault` |
| `FEE_CONSOLIDATOR_ADDRESS` | `FeeConsolidator` |
| `QUOTE_REGISTRY_ADDRESS` | `QuoteRegistry` |
| `CAUSE_REGISTRY_ADDRESS` | `CauseRegistry` |
| `EPOCH_GOVERNOR_ADDRESS` | `EpochGovernor` |
| `DONATION_DISTRIBUTOR_ADDRESS` | `DonationDistributor` |
| `TOKEN_REGISTRY_ADDRESS` | `TokenProfileRegistry` (ENS labels, controller, editor, records) |
| `VOTING_SCHEME_ADDRESS` | `ZamaVotingScheme`, shared by both governors |
| `TAKEOVER_GOVERNOR_ADDRESS` | `TakeoverGovernor` |
| `START_BLOCK` | Deployment block; every contract is indexed from it |
| `DATABASE_URL`, `DATABASE_SCHEMA` | Postgres (PGlite when unset) |

The browser-facing options (`CORS_ALLOWED_ORIGINS`, rate limits, SSE limits, Endaoment proxy)
are documented in `.env.example`.

Only the configured voting scheme is indexed. If a governor switches to a new scheme, add that
contract to `ponder.config.ts`; polls on an unindexed scheme show as `poll: null`.

## Tables

| Table | Key | Source |
| --- | --- | --- |
| `token` | `address` | `TokenCreated`; `name`/`symbol` read from the token at the launch block (empty strings if the read fails); profile columns (`label`, `labelhash`, `controller`, `editor`, `logoRef`, `contenthash`, `suppressed`, `registeredAt`) mirrored from `token_profile` |
| `token_profile` | `token` | `TokenRegistered` and the registry's profile events. Kept separately because the registry emits before the factory in the launch transaction |
| `token_text_record` | `token, key` | `TextChanged` (latest value per key) |
| `profile_update` | event id | One row per controller, editor, text, logo or contenthash change (the logo set during registration is not counted) |
| `fee_total`, `fee_collection`, `fee_consolidation`, `consolidation_failure`, `consolidation_total` | | Fee vault and consolidator |
| `quote_asset`, `cause`, `org_deployment`, `donation` | | Registries and distributor |
| `epoch` | `token, epoch` | Votes, `EpochOpened` (`opened`, `openedAt`, `governor`, `scheme`), `EpochClosed`, `NoVoteFallbackApplied` (`fallbackApplied`), `EpochFinalized`, donations. `voterCount` equals `voteCount` |
| `epoch_option` | `token, epoch, index` | Options frozen by `EpochOpened` |
| `epoch_clock` | `id` | `epochZeroStart` and `epochLength` of the epoch governor (see below) |
| `shortlist` | `token` | `ShortlistSet`; an empty list means the token uses the default |
| `default_shortlist` | `id = "default"` | `DefaultShortlistSet` |
| `poll` | `governor, token, scope` | Scheme `PollOpened`, `BallotCast` (`ballotCount`), `TallyRequested` (`closed`), `TallySubmitted` (`isFinal`, `counts`). `scope` is the epoch for the epoch governor and the proposal id for the takeover governor |
| `ballot` | `ballotRef` | `BallotCast`: voter and weight (public on-chain), never the choice |
| `takeover_proposal` | `proposalId` | `TakeoverProposed` and the lifecycle events |
| `takeover_vote` | `voteRef` | `TakeoverVoteCast` |
| `vote` | event id | `VoteCast` |

**Epoch timing.** `epochZeroStart` is an immutable aligned to a whole week since unix time 0.
`EpochOpened` and `VoteCast` only happen during the epoch they name, so the first of them gives
`epochZeroStart = floor(timestamp / week) * week - epoch * week` without an RPC call. Until one
has been indexed the API returns `start`, `end` and `snapshot` as null.

**Takeover execution deadline.** `TakeoverProposed` does not carry it. The handler reads
`getProposal(id)` at the proposal block (exact, since parameters are captured per proposal),
falling back to `end + params().executionWindow`; if both reads fail it stays null and the API
never reports `Expired` for that proposal. `snapshot` is `start - 1`.

## HTTP API

All routes are `GET`, read-only, CORS-enabled and rate-limited per IP. Errors are
`{ "error": "invalid_request", "issues": [...] }` (400) or `{ "error": "not_found" }` (404).
No route accepts or filters by a wallet address of the viewer (see `docs/PRIVACY.md`).

| Route | Response |
| --- | --- |
| `/api/health` | `{ status: "ok" }` |
| `/api/tokens?cursor&limit` | `{ items: Token[], nextCursor }`; each item has every `token` column plus `feeTotals` |
| `/api/tokens/:address` | `Token & { feeTotals, profile, shortlist, defaultShortlist }` |
| `/api/tokens/by-label/:label` | Same as the detail; 400 unless the label passes `isValidLabel`, 404 if unregistered |
| `/api/activity?kind&token&cursor&limit` | `{ items: ActivityItem[], nextCursor }` |
| `/api/activity/stream?token` | Server-Sent Events, `Last-Event-ID` resume |
| `/api/causes`, `/api/causes/search?q` | Causes and the Endaoment search proxy |
| `/api/epochs/:token?cursor&limit` | `{ items: Epoch[], nextCursor }` |
| `/api/epochs/:token/:epoch` | `Epoch & { start, end, snapshot, options, poll, donations }` |
| `/api/takeovers/:token` | `{ items: Proposal[] }`, newest first (at most 100) |
| `/api/takeovers/:token/:id` | `Proposal`; 404 if the id belongs to another token |
| `/api/polls/:governor/:token/:scope` | Raw `poll` row |
| `/api/stats` | USDC totals (6 decimals) |

```ts
type Token = {
  address, creator, pool, hook, lpTokenId, feeBps, metadataUri, createdAt, createdBlock, txHash,
  name: string, symbol: string,
  label: string | null, labelhash: Hex | null, controller: Hex | null, editor: Hex | null,
  logoRef: Hex | null, contenthash: Hex | null, suppressed: boolean, registeredAt: string | null,
};
// Detail only. `profile` is null until the token is registered; `contenthash` null means the
// registry default applies. Shortlists are null when unset or empty.
profile: { label, labelhash, controller, editor, logoRef, contenthash, suppressed, registeredAt,
           textRecords: Record<string, string> } | null;
shortlist: Hex[] | null; defaultShortlist: Hex[] | null;

type Epoch = {
  token, epoch, winningCauseId, finalizedAt, voteCount, donatedAmount, donatedPayout, donatedAt,
  opened: boolean, openedAt, closed: boolean, closedAt, voterCount: number,
  fallbackApplied: boolean, governor: Hex | null, scheme: Hex | null,
};
// Detail only. `end` is exclusive; `snapshot` = start - 1 (weights are read there).
start: string | null; end: string | null; snapshot: string | null; options: Hex[];
poll: { opened, closed, isFinal, optionCount, counts: string[] | null, ballotCount, scheme } | null;

type Proposal = {
  proposalId, token, proposer, newController, start, end, executionDeadline: string | null,
  snapshot, quorumWeight, forWeight, againstWeight, closed, tallied, executed, canceled,
  ballotCount: number, createdAt, txHash,
  state: "Active" | "Closing" | "Defeated" | "Succeeded" | "Executed" | "Canceled" | "Expired",
};
```

`state` follows `TakeoverGovernor.state` using the indexed fields and the server clock: canceled,
then executed; once tallied, defeated unless FOR reaches the quorum and beats AGAINST, expired after
the execution deadline, else succeeded; before the tally, active until `end` unless closed early,
expired after the deadline, else closing.

### Activity kinds

`launch`, `fees`, `consolidated`, `donation`, `vote`, `epoch` (finalized), and:

| Kind | Timestamp | `data` |
| --- | --- | --- |
| `token_registered` | registration | `label`, `labelhash` |
| `profile_updated` | change | `field` (`controller`, `editor`, `text`, `logo`, `contenthash`), `key` (text only), `value` |
| `epoch_opened` | `openedAt` | `epoch`, `governor`, `scheme` |
| `epoch_closed` | `closedAt` | `epoch`, `voterCount` |
| `takeover_proposed` | creation | `proposalId`, `proposer`, `newController`, `start`, `end`, `quorumWeight` |
| `takeover_executed` | execution | `proposalId`, `newController`, `forWeight`, `againstWeight` |
| `tally_submitted` | `finalAt` | `governor`, `scope`, `optionCount`, `ballotCount`, `counts` |

Item ids are `<kind>:<key>`; `kind` accepts a comma-separated list. `txHash` is null for the
epoch, takeover-executed and tally kinds.

The legacy unversioned routes (`/tokens`, `/epochs`, `/winners`, ...) and `/graphql` are served
from the same app and include the new columns and tables.
