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
| `TOKEN_REGISTRY_ADDRESS` | `TokenProfileRegistry` (ENS labels, controller, editor, records, cause focus) |
| `CAUSE_CATALOG_ADDRESS` | `CauseCatalog` (published catalogue versions) |
| `CURATOR_REGISTRY_ADDRESS` | `CuratorRegistry` (curator agents, weekly curations; their `AgentVault`s are found through `AgentRegistered`) |
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
| `token` | `address` | `TokenCreated`; `name`/`symbol` read from the token at the launch block (empty strings if the read fails); profile columns (`label`, `labelhash`, `controller`, `editor`, `logoRef`, `contenthash`, `suppressed`, `registeredAt`) mirrored from `token_profile`; `categoryMask`, `regionMask` mirrored from `token_focus` |
| `token_focus` | `token` | `FocusSet`: the cause focus fixed at launch (emitted before `TokenCreated`) |
| `catalog_version` | `version` | `CatalogVersionSet`: root, Swarm reference, entry count and `setAt` (a version applies to epochs starting after it) |
| `token_profile` | `token` | `TokenRegistered` and the registry's profile events. Kept separately because the registry emits before the factory in the launch transaction |
| `token_text_record` | `token, key` | `TextChanged` (latest value per key) |
| `profile_update` | event id | One row per controller, editor, text, logo or contenthash change (the logo set during registration is not counted) |
| `fee_total`, `fee_collection`, `fee_consolidation`, `consolidation_failure`, `consolidation_total` | | Fee vault and consolidator. `FeesCollected` is one deposit with its totals: `fee_total.collections` counts deposits, and `fee_collection.depositSeq` is the token's 1-based deposit number |
| `fee_attribution` | event id | `FeesAttributed`: one non-zero part of a deposit, `causeAmount` earned in `accrualEpoch` credited to the pool of `epoch` (the accrual epoch, or the first unsettled one after it). Emitted just before the deposit's `FeesCollected`; the parts share its `depositSeq` and sum to its `causeAmount` |
| `cause_pool_attribution` | `token, epoch, accrualEpoch` | Running sum of `FeesAttributed` per pool epoch and accrual epoch (`causeAmount`, `parts`); the rows of an epoch sum to `epoch.causeAttributed` |
| `quote_asset`, `cause`, `org_deployment`, `donation` | | Registries and distributor |
| `epoch` | `token, epoch` | Votes, `EpochOpened` (`opened`, `openedAt`, `governor`, `scheme`), `EpochClosed` (`closed`, `closedAt`, clears `closeFailed`), `EpochCloseFailed` (`closed` and `closeFailed`, as on-chain; no `closedAt`), `NoVoteFallbackApplied` / `TallyTimeoutFallbackApplied` (`fallbackApplied`, `fallbackReason` = `no_votes` / `timeout`), `EpochFinalized`, donations, `BallotPrepared` (`prepared`, `preparedAt`, `catalogVersion`, `poolSize`, `pinnedCount`), `LaunchSnapshotSet` (`launchSnapshot`), `FeesAttributed` (`causeAttributed`), `Settled` (`settledAmount`, `settledAt`). `voterCount` equals `voteCount` |
| `epoch_option` | `token, epoch, index` | Options fixed by `BallotPrepared` (also written by `EpochOpened`) |
| `epoch_clock` | `id` | `epochZeroStart` and `epochLength` of the epoch governor (see below) |
| `shortlist` | `token` | The controller's pinned causes. `ShortlistScheduled`: latest list `causeIds` from epoch `effectiveFrom`, and `previousCauseIds` before it. `ShortlistSet` is only used until the first scheduled event (`scheduled` false) |
| `poll` | `governor, token, scope` | Scheme `PollOpened`, `BallotCast` (`ballotCount`), `TallyRequested` (`closed`), `TallySubmitted` (`isFinal`, `counts`). `scope` is the epoch for the epoch governor and the proposal id for the takeover governor |
| `ballot` | `ballotRef` | `BallotCast`: voter and weight (public on-chain), never the choice |
| `takeover_proposal` | `proposalId` | `TakeoverProposed` and the lifecycle events; `lookbackSnapshot` and `circulatingWeight` from `getProposal`; `generation` = the token's executions when created |
| `takeover_token` | `token` | `TakeoverSuperseded` (emitted on every execution): `executions`, `lastExecutedProposalId` |
| `takeover_vote` | `voteRef` | `TakeoverVoteCast` |
| `vote` | event id | `VoteCast` |

**Epoch timing.** `epochZeroStart` is an immutable aligned to a whole week since unix time 0.
`EpochOpened` and `VoteCast` only happen during the epoch they name, so the first of them gives
`epochZeroStart = floor(timestamp / week) * week - epoch * week` without an RPC call. Until one
has been indexed the API returns `start`, `end` and `snapshot` as null.

If no epoch event has been indexed yet, the first pin schedule reads `epochZeroStart` from
the governor instead. `LaunchSnapshotSet` is emitted during the epoch it names and also fixes it.

**Weight snapshots.** An epoch's weights are read at `snapshotFor(token, epoch)`: `start - 1`,
except in the launch epoch of a token registered without supply at that point, where the
governor sets a launch snapshot inside the epoch (`LaunchSnapshotSet`). The epoch detail's
`snapshot` follows the same rule, so it is known for the launch epoch even before the clock is.

**Cause pools.** A deposit splits its fees by the epoch they were earned in. Each part goes to
the pool of that epoch, or of the first later epoch not yet settled, and the pool of an epoch is
paid out once (`Settled`). The epoch detail's `causePool` shows what was credited to the epoch
and from which accrual epochs, what is still held, and where fees earned in the epoch went when
its own pool had already settled (`carriedForward`).

**Pin schedules.** A change applies from the current epoch while its ballot is not prepared yet,
otherwise from the next one. The governor returns that epoch as `effectiveFrom`, so the current
epoch at the event is at least `effectiveFrom - 1`: a stored list scheduled from before that has
applied and becomes `previousCauseIds`; a list that has not applied yet is simply replaced. The API
resolves the list in effect from the epoch clock and the server time.

**Takeover reads.** `TakeoverProposed` does not carry the execution deadline, lookback snapshot
or circulating weight. The handler reads `getProposal(id)` at the proposal block (exact, since
parameters are captured per proposal), falling back to `end + params().executionWindow` for the
deadline; if both reads fail they stay null and the API never reports `Expired` for that
proposal. `snapshot` is `start - 1`.

**Superseded takeovers.** Several proposals of one token can be pending at once (the cooldown is
per proposer). Executing one makes every other pending proposal of the token created before it
`Superseded`. The contract tracks this with a per-token execution counter stamped on each
proposal; the indexer stores the same counter (`generation`, `takeover_token.executions`), which
also covers a proposal with a higher id that was created before the execution.

## HTTP API

All routes are `GET`, read-only, CORS-enabled and rate-limited per IP. Errors are
`{ "error": "invalid_request", "issues": [...] }` (400) or `{ "error": "not_found" }` (404).
No route accepts or filters by a wallet address of the viewer (see `docs/PRIVACY.md`).

| Route | Response |
| --- | --- |
| `/api/health` | `{ status: "ok" }` |
| `/api/tokens?cursor&limit` | `{ items: Token[], nextCursor }`; each item has every `token` column plus `feeTotals` |
| `/api/tokens/:address` | `Token & { feeTotals, profile, shortlist, shortlistPending, focus }` |
| `/api/tokens/by-label/:label` | Same as the detail; 400 unless the label passes `isValidLabel`, 404 if unregistered |
| `/api/activity?kind&token&cursor&limit` | `{ items: ActivityItem[], nextCursor }` |
| `/api/activity/stream?token` | Server-Sent Events, `Last-Event-ID` resume |
| `/api/causes`, `/api/causes/search?q` | Causes and the Endaoment search proxy |
| `/api/epochs/:token?cursor&limit` | `{ items: Epoch[], nextCursor }` |
| `/api/epochs/:token/:epoch` | `Epoch & { start, end, snapshot, options, poll, donations, causePool }` |
| `/api/takeovers/:token` | `{ items: Proposal[] }`, newest first (at most 100) |
| `/api/takeovers/:token/:id` | `Proposal`; 404 if the id belongs to another token |
| `/api/polls/:governor/:token/:scope` | Raw `poll` row |
| `/api/stats` | USDC totals (6 decimals) |
| `/api/catalog` | Loaded catalogue: `root`, taxonomy version, org and entry counts, per-category and per-region org counts, `bucketSizes` |
| `/api/catalog/search?q&categories&regions&offset&limit` | `{ items: CatalogOrg[], total }` (comma-separated slugs; none means any) |
| `/api/catalog/pool?categories&regions` | `{ poolSize, buckets: [{ bucket, category, region, size }] }` |
| `/api/catalog/entries?at=bucket:index,...` | `{ root, items: [{ bucket, index, orgId, proof }] }`, at most 100 entries (what the keeper's `prepareBallot` needs) |
| `/api/catalog/causes?ids=0x..,...` | `{ items: CatalogOrg[] }` by cause id, at most 50 (names for ballot options) |
| `/api/catalog/orgs/:id` | `{ root, org, entries }` by org id, cause id, EIN or Endaoment id, entries with proofs |

The `/api/catalog/*` routes answer 503 `catalog_unavailable` until the snapshot at
`CATALOG_SOURCE` (a directory, or a Swarm gateway URL such as `https://<gateway>/bzz/<swarmRef>`)
has loaded. The catalogue is held in memory (a full catalogue takes a few hundred MB); clients
should compare `root` with `CauseCatalog.rootOf` for the version they use.

```ts
type Token = {
  address, creator, pool, hook, lpTokenId, feeBps, metadataUri, createdAt, createdBlock, txHash,
  name: string, symbol: string,
  label: string | null, labelhash: Hex | null, controller: Hex | null, editor: Hex | null,
  logoRef: Hex | null, contenthash: Hex | null, suppressed: boolean, registeredAt: string | null,
};
// Detail only. `profile` is null until the token is registered; `contenthash` null means the
// registry default applies. `shortlist` is the pinned causes in effect for the current epoch
// (null when none); `shortlistPending` is a list scheduled from a later epoch (`causeIds` may be
// empty: all pins removed), or null. `focus` is null until `FocusSet` is indexed.
profile: { label, labelhash, controller, editor, logoRef, contenthash, suppressed, registeredAt,
           textRecords: Record<string, string> } | null;
shortlist: Hex[] | null; shortlistPending: { causeIds: Hex[], effectiveFrom: string } | null;
focus: { categoryMask: string, regionMask: number, categories: string[], regions: string[] } | null;

type Epoch = {
  token, epoch, winningCauseId, finalizedAt, voteCount, donatedAmount, donatedPayout, donatedAt,
  opened: boolean, openedAt, closed: boolean, closedAt, closeFailed: boolean, voterCount: number,
  fallbackApplied: boolean, fallbackReason: "no_votes" | "timeout" | null,
  governor: Hex | null, scheme: Hex | null,
  prepared: boolean, preparedAt, catalogVersion: number | null, poolSize: string | null,
  pinnedCount: number | null,
  launchSnapshot: string | null, causeAttributed: string,
  settledAmount: string | null, settledAt: string | null,
};
// Detail only. `end` is exclusive; `snapshot` = `snapshotFor(token, epoch)` (weights are read
// there): `launchSnapshot` when set, else start - 1.
start: string | null; end: string | null; snapshot: string | null; options: Hex[];
poll: { opened, closed, isFinal, optionCount, counts: string[] | null, ballotCount, scheme } | null;
// USDC base units. `accruals`: credited to this pool, by accrual epoch (ascending);
// `carriedForward`: earned in this epoch but credited to a later pool. `pending` is 0 once settled.
causePool: {
  attributed: string, pending: string, settledAmount: string | null, settledAt: string | null,
  accruals: { accrualEpoch: string, causeAmount: string, parts: number }[],
  carriedForward: { epoch: string, causeAmount: string, parts: number }[],
};

type Proposal = {
  proposalId, token, proposer, newController, start, end, executionDeadline: string | null,
  snapshot, lookbackSnapshot: string | null, circulatingWeight: string | null,
  quorumWeight, forWeight, againstWeight, closed, tallied, executed, canceled,
  ballotCount: number, createdAt, txHash,
  state: "Active" | "Closing" | "Defeated" | "Succeeded" | "Executed" | "Canceled" | "Expired"
       | "Superseded",
};
```

`state` follows `TakeoverGovernor.state` using the indexed fields and the server clock: canceled,
then executed; once tallied, defeated unless FOR reaches the quorum and beats AGAINST, expired after
the execution deadline, else succeeded; before the tally, active until `end` unless closed early,
expired after the deadline, else closing. An active, closing or succeeded proposal is
`Superseded` when another proposal of the token executed after it was created.

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
