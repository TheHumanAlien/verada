# Verada Architecture

Verada is a memecoin launchpad on Ethereum mainnet (chain id 1). Every token launches into a
Uniswap v4 pool paired with an approved quote asset (WETH or an Ondo token), with single-sided
liquidity that is locked permanently. Trading fees are consolidated to USDC and split between the
platform and a per-token cause pool. Each token chooses a cause focus at launch (categories such as
hunger or endangered species, and regions such as Africa), and its holders vote weekly, with hidden
choices, on which Endaoment-listed nonprofit inside that focus receives the accumulated cause funds. Every token gets an ENS subname
(`<label>.varada.eth`) with an editable profile and a page on the Swarm-hosted dApp. Twenty
curator agents, one per cause (`<label>.agent.varada.eth`), publish weekly ranked picks that fill
part of each ballot; see [Curator agents](#curator-agents).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project (solc 0.8.26, cancun). Dependencies under `contracts/lib` as git submodules. |
| `packages/sdk` | ABIs, addresses, viem helpers, fee math. |
| `packages/endaoment-client` | Typed Endaoment organization search client. |
| `packages/cause-catalog` | Harvests Endaoment orgs, classifies them by cause and region, and builds the catalogue Merkle tree (`verada-catalog` CLI). |
| `packages/curator` | Curator agent tooling (`verada-curator` CLI): weekly report schema (`verada.curation/v1`), pick trees, calldata, and the 1Claw signer. |
| `services/indexer` | Ponder indexer and API over protocol events, plus the x402 paid data routes. |
| `apps/web` | Next.js app built as a static export (token list, launch, token page, causes, governance, curator agents). |
| `packages/publish` | Swarm upload, site feed updates and ENS contenthash tooling (dry-run by default). |
| `packages/arkiv-registry` | Arkiv entity schemas, reconcile planning and client for the token mirror. |
| `services/publisher` | Logo/metadata uploads to Swarm, signed curator report uploads, stamp watch, Arkiv mirror, the ballot and tally keeper, and the mainnet x402 facilitator. |
| `agents/` | Curator agent operations: provisioning, weekly routines, monitoring and the pause/recovery runbook (`agents/README.md`). |
| `infra/` | AWS CDK app. |

## Contracts

| Contract | Responsibility |
|---|---|
| `VeradaToken` | ERC20 with permit, burn and vote checkpoints (ERC20Votes with a timestamp clock; holders are self-delegated on first receipt). Fixed supply minted to the factory. Immutable creator and metadata URI. |
| `VeradaFactory` | `deployToken`: deploys the token via CREATE2, registers its ENS label, logo and cause focus in the profile registry, initializes the v4 pool (token/quote, dynamic fee, Verada hook), mints single-sided liquidity through the position manager, sends the position NFT to the locker, and registers the token with the fee vault and governor. |
| `QuoteRegistry` | Owner-managed allowlist of quote assets. |
| `FeeConsolidator` | Swaps collected fees into USDC through Uniswap v4 before the split. |
| `TokenProfileRegistry` | Per-token profile: ENS label, controller and editor roles, text records, logo reference, contenthash override, suppression flag, and the cause focus (category and region masks, written once at launch). Factory-written at launch; the takeover governor may replace a controller. |
| `VeradaResolver` | Stateless ENSIP-10 wildcard resolver for `varada.eth`: answers `addr`, `text`, `contenthash` for every `<label>.varada.eth` from the registry, and for `agent.varada.eth` and every `<label>.agent.varada.eth` from `CuratorRegistry`. |
| `TakeoverGovernor` | Community takeover votes that replace a token's profile controller. |
| `ZamaVotingScheme` | `IVotingScheme` implementation that hides ballot choices with Zama FHEVM and reveals only aggregates. |
| `VeradaHook` | Uniswap v4 hook. Sets the dynamic fee (base fee plus a decaying anti-sniper surcharge) and routes collected fees to the fee vault. |
| `VeradaLpLocker` | Holds liquidity position NFTs permanently. Principal can never be withdrawn; only accrued fees are collected and forwarded to the fee vault. |
| `FeeVault` | Splits incoming fees between platform and cause pool; tracks balances per token; releases a token's cause pool for an epoch once a winner exists. |
| `CauseCatalog` | Owner-published, versioned Merkle root over every eligible Endaoment org, bucketed by `category x region`, with per-bucket sizes and the Swarm reference of the snapshot. A version applies to epochs starting after it is set. |
| `CauseRegistry` | Causes that can be paid: `causeId` (`keccak256` of the 32-byte Endaoment org id) to the org's factory-computed address and an active flag. The governor materializes catalogue winners into it; the owner can add causes directly or block any org. |
| `EpochGovernor` | Weekly epochs. Builds each epoch's ballot from the token's pinned causes, curator agents' picks and rotation draws over its focus pool, authorizes voters by vote checkpoints, and records the winning cause from the scheme's tally on finalization. |
| `DonationDistributor` | After finalization, sends the epoch's cause funds to the winning cause's payout address. |
| `CuratorRegistry` | One curator agent per cause category: ERC-8004 identity (owned by the registry), signer, vault, active flag and ENS label. Accepts each agent's weekly curations for the next epoch. |
| `AgentVault` | Per-agent USDC donation vault. Only the agent's signer can give, only to unblocked catalogue orgs in the agent's own buckets, within a per-epoch cap. No withdrawal. |
| `IPrivateDonationAdapter` | Interface only; see Deferred work. |

### Fee model

- The pool LP fee is dynamic and set per token at launch, between 1% and 5%, plus an optional
  anti-sniper surcharge that decays to zero over a short window after launch.
- Collected fees are split by `FeeVault` using a single constant, `PLATFORM_SHARE_BPS = 1000`:
  - 10% goes to the platform treasury.
  - 90% goes to the token's cause pool.
- Basis-point math uses a denominator of 10,000 and rounds in favor of the cause pool. The split is
  defined in one place only and is never duplicated elsewhere.

```
swap -> VeradaHook (dynamic fee) -> FeeVault
LP fees -> VeradaLpLocker.collectFees -> FeeVault
FeeVault --10%--> platform treasury
FeeVault --90%--> causePool[token] --settle(epoch winner)--> DonationDistributor --> cause payout
```

### Weekly epoch governance (hidden choices)

- Epochs last 7 days. Epoch 0 starts at a Thursday 00:00 UTC boundary at or before deployment.
- A token's focus is fixed at launch: a set of catalogue categories and a set of regions. Its pool
  is every catalogue entry in those `category x region` buckets, under the catalogue version in
  effect when the epoch starts. The factory rejects a focus whose pool has fewer than two entries.
- Each epoch's ballot holds up to 32 causes (`EpochGovernor.ballotSize`), filled in three phases
  (`_prepare`):
  1. **Pins.** The token's controller may pin up to 8 catalogue orgs inside the focus (with Merkle
     proofs); pins lead the ballot and change from the next epoch once the current ballot is
     prepared. Blocked pins are skipped.
  2. **Curated picks.** For each focus bucket, `CuratorRegistry.curationsFor` returns the curation
     its agent submitted for this epoch (see [Curator agents](#curator-agents)), or nothing when
     the agent is inactive, submitted nothing, gave weight 0 or used another catalogue version than
     the one in effect at the epoch's start. The free slots are split by weight (`_quotas`,
     mirrored by the SDK's `curatedQuotas`): each curation first gets
     `min(count, floor(slots * weight / totalWeight))`, then leftover slots go one at a time to
     curations still below their pick count, in ascending bucket order, round after round, until
     the slots run out or every curation is at its count. Bucket by bucket, ranks
     `0..quota-1` are then taken in order.
  3. **Rotation.** The remaining slots are filled by rotation: draw `k` is pool entry
     `keccak256(abi.encode(token, epoch, version, k)) % poolSize`, skipping repeats (an org in
     several buckets, or already pinned or picked) and blocked orgs, for at most three draws per
     free slot; a pool that fits the free slots is taken whole, in order. Nobody can choose the
     draws, and over time every charity in the focus reaches a ballot.
- A curated draw (`IEpochGovernor.CuratedDraw`) carries two proofs: the pick leaf
  `(uint8 rank, uint32 catalogIndex, bytes32 orgId)` against the agent's picks root, and the
  catalogue leaf actually at `(bucket, catalogIndex)` against the catalogue root. A bad proof of
  either kind reverts (`InvalidCuratedDraw`), so whoever prepares the ballot cannot substitute
  picks. Picks are not checked when the agent submits them; at ballot time a pick is skipped when
  the catalogue entry at its index is a different org (a pick from outside the bucket, or a stale
  index), when its index is past the bucket's end (no entry proof is needed then), when the org is
  blocked, or when it repeats an earlier option. A skipped pick still uses its rank, and its slot
  passes to rotation. `CuratedPicksUsed(token, epoch, drawn, included)` records how many picks were
  checked and how many reached the ballot.
- `CURATION_GRACE` is 6 hours. Until then, a ballot whose focus buckets have usable curations can
  only be prepared with its curated draws (`prepareCuratedBallot`); `prepareBallot` and
  `openEpoch` revert with `IncompleteCuratedBallot`. After the grace they skip the curated phase,
  so rotation fills the ballot, while `prepareCuratedBallot` still applies the picks. An agent that
  submits a root but never publishes its picks can make the epoch unpreparable without its picks
  for 6 hours; anyone can then open it with rotation, and the platform keeper does so on its first
  run at least 30 seconds after the grace ends (see the keeper below).
- Anyone may fix the ballot with `prepareBallot(token, epoch, draws)`, supplying each drawn entry
  and its proof, or with `prepareCuratedBallot(token, epoch, curated, draws)` when the curated phase
  takes slots. A ballot that needs no draws opens with `openEpoch(token, epoch)`. Ballots are
  rejected until the epoch is opened, so a ballot's option index always refers to the frozen
  `epochOptions`. A ballot of fewer than two options opens no poll and the epoch pays the
  default cause.
- The publisher's keeper opens every registered token's current epoch. It reads
  `curationsFor` for the token's focus buckets, computes the quotas, fetches each curated bucket's
  pick leaves and proofs from the indexer (`/api/agents/:label/picks/:epoch/:region`; the root
  must equal the one on chain) and the catalogue entries with proofs (the root must equal the
  epoch's version), plans the ballot locally with the SDK's `planBallot` (which mirrors
  `_prepare`), and sends `openEpoch`, `prepareCuratedBallot` when any slot is curated, or
  `prepareBallot`. If a usable curation's picks cannot be fetched, the step fails with
  `CuratedPicksUnavailable`, which carries the governor's grace end (`epochStart + CURATION_GRACE`,
  read on chain). The keeper retries with exponential backoff (5 minutes, doubling, at most 6 hours
  apart; a publisher restart clears it), but never waits past the grace end plus a 30-second margin
  for block time. That retry, on the keeper's first run from then (every `KEEPER_INTERVAL_SECONDS`,
  300 by default), prepares the whole ballot with rotation only; with picks missing from the start
  of the epoch, that is a few minutes after 6 hours in.
- Voting weight is the holder's `VeradaToken.getPastVotes` one second before the epoch start,
  counted in whole tokens. In the epoch a token launches in, that time predates the token, so its
  weights are read at a launch snapshot one day after registration instead (halfway to the
  epoch's end when less than two days remain; `snapshotFor`, `launchSnapshotOf`). The voter and
  weight are public; the choice is not.
- Ballots go to the voting scheme directly (`IVotingScheme.castBallot(governor, token, epoch,
  ballot)`), because encrypted inputs are bound to the transaction sender. The scheme calls back
  `EpochGovernor.authorizeBallot`, which checks eligibility, records the voter and emits `VoteCast`.
- `ZamaVotingScheme` packs three 40-bit counters into each encrypted `euint128` word (11 words for
  32 options) and adds the voter's weight to the counter their encrypted index selects, touching
  every word so nothing reveals the choice; one 32-option ballot costs about 971k gas of FHE work. After the epoch, `closeEpoch` makes the tallies publicly
  decryptable; the publisher's tally keeper fetches the decryption and KMS proof from Zama's relayer
  and calls `submitTally`, which verifies the proof on-chain. `finalizeEpoch` then stores the
  winning `causeId` (ties go to the lowest ballot index; an epoch without ballots falls back to the
  owner-set default cause) and materializes a catalogue winner into `CauseRegistry` from the
  Endaoment factory's `computeOrgAddress`. If no verified tally arrives within two weeks of the epoch's end, the
  epoch also falls back to the default cause, so a cause pool can never be stranded. The fee vault
  settles that epoch's cause pool to `DonationDistributor`.
- The scheme is pluggable per governor. Interfold (CRISP) or a self-hosted Noir/Barretenberg scheme
  can replace Zama without changing the governors.

### Community takeover

Holders can replace an absent or unwanted profile controller. `TakeoverGovernor.propose` needs a
minimum token age, a per-proposer cooldown and a proposer weight above a threshold; it opens a
two-option poll (AGAINST, FOR) on the scheme. Several proposals for one token may run at once;
executing one supersedes the older ones. Voting weight is the smaller of a holder's votes at the
snapshot (the second before the proposal) and at `lookback` earlier (one week by default), so
tokens bought for a single block carry no weight. Quorum and threshold are basis points of the
circulating supply at the snapshot, which excludes the Uniswap pool manager's locked balance.
After the voting period the proposal is closed and tallied; it succeeds when FOR reaches the
quorum and beats AGAINST, and `execute` within the execution window (at least two days, to leave
room for decryption) calls `TokenProfileRegistry.setController`. Only the proposer, or the owner
while voting is still open, may cancel.

Key events consumed by the indexer and SDK: `TokenCreated`, `FeesCollected`, `CauseAdded`,
`CauseDeactivated`, `CatalogVersionSet`, `FocusSet`, `BallotPrepared`, `EpochOpened`, `EpochClosed`,
`EpochFinalized`, `Donated`, `VoteCast`, `CuratedPicksUsed`,
`TokenRegistered`, `ControllerChanged`, `EditorChanged`, `TextChanged`, `ContenthashChanged`,
`LogoChanged`, the scheme's `PollOpened`/`BallotCast`/`TallyRequested`/`TallySubmitted` and the
takeover governor's `TakeoverProposed`/`TakeoverVoteCast`/`TakeoverTallied`/`TakeoverExecuted`,
the curator registry's `AgentRegistered`/`SignerSet`/`ActiveSet`/`AgentWalletLinked`/`CurationSet`/`CurationsSubmitted`
and the agent vaults' `Donated`/`Given`.

### Deferred work

- **Trust-minimised private voting**: Zama's threshold KMS is the day-zero trust anchor. Interfold's
  CRISP (bonded ciphernode network) is the intended replacement once its voting program reaches
  mainnet; a self-hosted Noir/Barretenberg scheme (exponential ElGamal ballots, k-of-n committee
  decryption) was researched as the fallback. Both plug into `IVotingScheme`.
- **Private donations** are deferred. `IPrivateDonationAdapter` defines the shielded send route, with
  no implementation yet. Donations currently go directly to the cause payout address.
- **Arkiv mainnet**: the mirror runs against the Rabdi testnet until Arkiv ships a mainnet.
- **Catalogue on Arkiv**: Arkiv mirrors each token's focus, not the catalogue itself. Mirroring
  catalogue versions and per-org entries needs indexer listings for them and a measure of Arkiv
  write throughput and lifetime-extension cost for a few hundred thousand entities.
- **Preparing a ballot from the web app**: the keeper prepares ballots; the dApp only shows that a
  ballot is not prepared yet.

## Token profiles and ENS subnames

Every launch registers a label in `TokenProfileRegistry`; `<label>.varada.eth` exists exactly when
the token exists, with no per-name ENS transaction. `varada.eth` is registered on ENSv2 and its
resolver is `VeradaResolver`, an ENSIP-10 wildcard resolver that the Universal Resolver reaches
for every subname. Records: `addr` is the token address and can never change; `contenthash` is the
registry's default (the dApp's Swarm feed manifest) unless the controller sets an override; text
records (`url`, `description`, `avatar`, `com.twitter`, `org.telegram`, `com.discord`) are edited by
the controller or an appointed editor; `verada.logo` is synthesized from the on-chain logo
reference. The registry owner can reserve labels and suppress a profile (the resolver then answers
empty values while the label stays taken).

## Curator agents

Twenty curator agents, one per cause category (every category except `other`), research their
cause each week and publish ranked picks for the next epoch's ballots. They are run by the
platform. They cannot pin causes or vote, and no ballot depends on them: rotation fills any slot
they leave empty. Operating them is described in [`agents/README.md`](../agents/README.md).

### Identities and names

- `CuratorRegistry` (owned by the platform) holds one agent per category bit: its ERC-8004 agent
  id, signer, vault, active flag, ENS label and description. `registerAgent(categoryBit, label,
  signer, agentURI, description)` deploys the agent's `AgentVault` (CREATE2, salt = category bit)
  and registers an identity on the ERC-8004 Identity Registry on mainnet
  (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) with metadata `verada.category` and
  `verada.vault`. The registry owns the identity NFT. The registry is the source of truth; ERC-8004
  (a Draft standard behind an upgradeable proxy) is the public identity layer, and no Verada
  contract depends on its state after registration.
- `linkAgentWallet` makes the vault the identity's ERC-8004 agent wallet. The Identity Registry
  checks the signer's EIP-712 `AgentWalletSet(agentId, newWallet, owner, deadline)` signature
  through the vault's ERC-1271 `isValidSignature`, which accepts the agent's current signer. The
  deadline may be at most 5 minutes ahead.
- The signer is a 1Claw HSM key. The owner can replace it (`setSigner`), pause or resume the agent
  (`setActive`), and update the agent URI and description. A paused agent cannot submit, its
  curations are ignored by the governor, and the publisher rejects its reports.
- Names are `<ensLabel>.agent.varada.eth`, with the labels from `packages/sdk/src/catalog.ts`
  (`homeless`, `wildlife`, `mental-health`, ...); a label is permanent once registered. The deploy
  script reserves the label `agent` in `TokenProfileRegistry`, so no token can take it.
  `VeradaResolver` answers the agent namespace from `CuratorRegistry`, with no ENS write per
  agent: `addr` is the agent's vault (`agent.varada.eth` itself resolves to the registry), text
  records are `url` (`https://<label>.agent.varada.eth.limo`), `description`, `verada.category` and
  `agent-registration` (`eip155:1:<identity registry>:<agentId>`), and the contenthash is the
  site default. A label under `agent` that no agent holds resolves to the zero address and empty
  text records (its contenthash is still the site default); it never falls through to a token.

### Weekly curations

- `submitCurations(categoryBit, epoch, catalogVersion, reportRef, curations)` is accepted only
  from the agent's signer, only while the agent is active, and only for `currentEpoch() + 1`.
  `catalogVersion` must be between 1 and the latest catalogue version. Per region it stores a
  picks root, a pick count (at most 32; zero exactly when the root is zero) and an urgency weight
  (at most 10,000), and emits `CurationSet`; the submission emits `CurationsSubmitted` with
  `reportRef`, the Swarm reference of the full report. A submission replaces the regions it lists
  and can be repeated until the epoch starts, so a running epoch's ballot can never be reshaped.
- A pick leaf is the OpenZeppelin standard-tree leaf of `(uint8 rank, uint32 catalogIndex,
  bytes32 orgId)`, ranks `0..count-1`, one tree per region. Only the root goes on chain.
- A curation counts only under the catalogue version in effect at the epoch's start. A catalogue
  version set during the week therefore voids that week's earlier submissions until the agents
  submit again.
- One region's `submitCurations` measured about 63k gas on a mainnet fork
  (`test_fork_submitCurations`).

### Reports

- `packages/curator` (`verada-curator` CLI) covers the agent's side: `pool` lists a bucket's
  catalogue entries, `template` prints an empty report, `build` validates a report and builds the
  pick trees, `publish` uploads it, `submit` sends `submitCurations`, and `give` sends a vault gift.
  Transactions and signatures go through the 1Claw signer (`--dry-run` prints the transaction
  instead).
- A report (`ReportSchema`, `schema: "verada.curation/v1"`) names the category, epoch and
  catalogue version, has a title and newsletter introduction, and per region: the urgency weight,
  a summary, the week's events with sources, up to 32 ranked picks (org id, catalogue index, name,
  score 0-100, reasons, sources) and the region's newsletter. A region without picks has weight 0.
  `build` refuses any pick whose catalogue entry is a different org, and hashes the canonical
  (sorted-key) JSON of the report.
- `publish` signs the report hash (EIP-191) and posts the report to the publisher's
  `POST /agents/reports` with an `x-curator-signature` header. The publisher validates the schema,
  rebuilds the pick trees itself (uploaded trees are never trusted), requires the signature to
  recover to the active signer of the report's category in `CuratorRegistry`, and only then
  uploads `{ report, regions }` to Swarm. The returned reference is the `reportRef` the agent
  submits. Reports are limited to `MAX_REPORT_BYTES` (512 KiB by default) and the route is rate
  limited. Catalogue membership is not checked there; the governor checks it at ballot time.
- The indexer follows the registry and vault events and reads reports from the Swarm gateway
  (`/bzz/<ref>/`). A report region is `verified` when its tree has the root and count the agent
  submitted on chain. Free routes: `/api/agents` (every agent, with totals and latest report),
  `/api/agents/:label` (profile, totals, reports, latest curations, credited donations, gifts),
  `/api/agents/:label/reports/:epoch` and `/api/agents/:label/picks/:epoch/:region` (pick leaves
  with proofs, what `prepareCuratedBallot` needs; 404 `report_mismatch` when the report's root is
  not the one on chain).

### Agent vaults

- `AgentVault` holds USDC. Anyone can `donate(amount, credit)`; `credit` opts in to being named
  (see [PRIVACY.md](PRIVACY.md)). Plain transfers add to the balance without a `Donated` event.
- `give(regionBit, orgId, catalogIndex, proof, amount)` is the only way out. It needs the agent's
  current signer, an unpaused vault, an org that is an entry of the agent's own
  `(category, region)` bucket in the latest catalogue version (Merkle proof) and is not blocked in
  `CauseRegistry`, and room under `maxGivePerEpoch` (the total for the current epoch across all
  regions; zero, the default, allows no gifts). The gift goes through the Endaoment factory
  (`deployOrgAndDonate` for an org without a contract yet, the org's `donate` otherwise), checks
  the org's computed address and clears the allowance. A gift need not be one of the agent's picks.
- There is no withdrawal, no arbitrary call and no owner of its own. The platform (the registry's
  owner) sets the per-epoch cap and can pause gifts. Replacing the signer moves gift rights and the
  ERC-1271 check to the new key at once.

### Runtime and web

- Each agent runs as a weekly Claude scheduled cloud routine, staggered across the day before the
  epoch starts. The routine does the research and writing; every report signature and transaction
  goes through the agent's 1Claw key, whose 1Claw policies allow only the registry and the agent's
  own vault as destinations, zero value, a small daily transaction count, simulation first, and
  human approval for gifts above a USD threshold. News text is untrusted data, never instructions.
- A manipulated or compromised agent can, each epoch until it is paused, fill its buckets with
  bad picks and, by inflating its weight, take curated slots from other agents' buckets and from
  rotation on every token whose focus includes its buckets (holders still vote). It can also give
  up to the per-epoch cap to in-bucket orgs every epoch. Pausing the agent and its vault stops
  both.
- The web app has static pages at `/agent/`, `/agent/<label>/` and `/agent/<label>/<region>/`, and
  `<label>.agent.varada.eth.limo` serves the agent's page: agent names share the site contenthash,
  and the hostname selects the page.

## x402 paid data

The indexer sells packaged curator and catalogue data over x402 (version 2, `exact` scheme, USDC)
under `/x402/v1`. It is off unless `X402_ENABLED` is set; when off, every `/x402` path answers 404.

| Route | Default price | Contents |
|---|---|---|
| `GET /x402/v1/rankings/:label/:region` | $0.01 | The latest report's ranking for one cause and region: ranked picks with scores, reasons and sources, the week's events, and whether it is verified against the chain. |
| `GET /x402/v1/history/:label` | $0.10 | Every published ranking for one cause, all regions, newest first (`limit` 1-260, default 52). |
| `GET /x402/v1/newsletters/:label` | $0.02 | The newsletter archive for one agent (`limit` as above). |
| `GET /x402/v1/catalog/export` | $0.50 | The classified catalogue, filterable by `category` and `region`, paged (`offset`, `limit` up to 5,000). |

- `GET /x402/v1` is free: the price list with each route's payment options, and the free routes.
- Each route accepts USDC on Base (`eip155:8453`) first, then on Ethereum mainnet (`eip155:1`).
  Base payments are settled by Coinbase CDP's facilitator (`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`,
  or another facilitator at `X402_BASE_FACILITATOR_URL`). CDP does not settle on Ethereum
  mainnet, so mainnet payments go to the publisher's own facilitator (`X402_MAINNET_FACILITATOR_URL`
  and a bearer token); a mainnet payee without a facilitator URL is a configuration error.
- `payTo` is always a platform treasury (`X402_BASE_PAY_TO`, `X402_MAINNET_PAY_TO`). No x402
  revenue goes to agents or vaults.
- Prices are USD decimal strings (`X402_PRICE_RANKINGS`, `X402_PRICE_HISTORY`,
  `X402_PRICE_CATALOG`, `X402_PRICE_NEWSLETTERS`). On mainnet the price is
  `max(price, X402_MAINNET_MIN_PRICE)` ($0.50 by default) so a settlement's gas is covered.
  Payments time out after 120 seconds on Base and 300 on mainnet.
- The mainnet facilitator (`/x402/supported`, `/x402/verify`, `/x402/settle` on the publisher,
  enabled by `X402_FACILITATOR_ENABLED`) answers only the indexer's bearer token, only the
  `exact` scheme on its configured network, and only requirements whose `payTo` is
  `X402_FACILITATOR_PAY_TO`, because it pays the gas. It settles EIP-3009
  `transferWithAuthorization` on USDC with simulation first; smart-wallet deployment (ERC-6492) is
  disabled. The settlement key is a 1Claw key whose policy allows only the USDC contract, and the
  signer wrapper refuses any call other than `transferWithAuthorization` on USDC as well. A local
  key is accepted for development and fork tests only.
- A handler that answers 4xx or 5xx (unknown agent or region, no report, catalogue unavailable)
  cancels the payment, so a buyer is never charged for a miss. Paid responses are
  `Cache-Control: private, no-store`; CORS exposes `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`.
- What stays free: `/api/agents/*` (agents, reports one epoch at a time, picks with proofs) and
  `/api/catalog/*`. The dApp and anyone checking a ballot need these. The paid routes sell
  convenience and depth over the same public data: ranked lists, the full history, the newsletter
  archive and the classified catalogue as one export.

## Arkiv mirror

`services/publisher` reconciles the indexer's view of tokens and causes into Arkiv entities
(`verada.token` core records made read-only with burned ownership, `verada.token-profile` records
owned by the platform key and patched when records change on mainnet, `verada.cause` records) so
other chains and apps can query the token list. Since schema version 2 the core record carries the
token's cause focus: `causeCategory` and `causeRegion` hold comma-wrapped slug lists
(`,hunger,children-youth,`, or `*` for every category or region) so one cause or region can be
matched with a glob, next to the raw `categoryMask` and `regionMask`. Readers must check `$creator` equals the platform
address; the schema tag alone is spoofable. Entities expire after at most 182 days, so the mirror
also extends them. Mainnet remains the source of truth.

## Endaoment integration

Causes are sourced from Endaoment. `packages/endaoment-client` wraps the organization search API
with typed responses, runtime validation, pagination, retries and an injectable cache. Image URLs in
API responses are ignored.

### Cause catalogue

Every compliant Endaoment org with a mainnet address is eligible, without a transaction per org:

1. **Harvest** (`verada-catalog harvest`): the search API is crawled one NTEE major group at a time
   (about 250k orgs in November 2026), checkpointed and resumable. Endaoment bans an IP for about
   ten minutes after a 429, so the crawl is throttled and backs off in minutes; for the full crawl,
   ask Endaoment for a workload-specific rate limit.
2. **Classify** (`verada-catalog build`): the shared taxonomy (`packages/sdk/src/catalog.ts`, 21
   categories and 8 regions) maps specific NTEE codes to categories. Name and description keywords
   classify orgs whose code is missing, unclassified (`Z`), major-group-only or international
   (`Q*`), which covers most non-US orgs. A few high-precision phrases apply to every org whatever
   its code: "innocence project", "wrongful conviction" or "exoneration" place an org in Justice &
   the wrongly accused even when it is filed as civil rights or left unclassified. Regions come from the HQ country; international (`Q*`)
   orgs also get Global and any region their text names. Endaoment only reports an org's HQ, not
   where it works, so `packages/cause-catalog/region-overrides.json` holds curated corrections.
   Orgs nothing places land in `other`.
3. **Tree**: an org appears once in every `category x region` bucket it belongs to, ordered by org
   id; leaves are OpenZeppelin standard-tree leaves of `(uint16 bucket, uint32 index, bytes32 orgId)`.
4. **Publish**: the snapshot (`catalog.json`, `orgs.jsonl`, `tree.json`) is uploaded to Swarm
   (`verada-catalog publish`), and the owner signs `CauseCatalog.setVersion(root, bucketSizes,
   swarmRef)` (`verada-catalog calldata` prints it; the keeper key never sets roots). The indexer
   loads the snapshot (`CATALOG_SOURCE`) and serves `/api/catalog`, `/search`, `/pool`, `/entries`
   (with proofs), `/causes` and `/orgs/:id`.

Only the winner of an epoch is written to `CauseRegistry`, with the address the Endaoment factory
computes for its org id, which the distributor checks again before paying. The registry owner can
block any org (`blockOrg`): a blocked org is skipped by rotation, cannot be pinned and is never
reactivated by materialization. When a new catalogue version drops an org, block it too.

## Hosting model

There is no web server. The frontend is a static export published to Ethereum Swarm and reached
through ENS: `varada.eth` and every `<label>.varada.eth` resolve to the same contenthash, a Swarm
feed manifest that the publish tool points at the latest release. The always-on services are the
indexer with its Postgres database, the Bee node with its gateway (uploads), and the publisher, all
on AWS.

```
browser --ENS name--> gateway (eth.limo, bzz.link) --contenthash (feed manifest)--> Swarm feed --> release manifest --> static files
   |     (hostname label -> token page; `verada.com/<label>` for the plain-DNS deployment)
   |--HTTPS JSON + SSE--> indexer (ALB -> ECS Fargate) --> Postgres
   |--HTTPS multipart----> publisher (uploads: logo, metadata) --> swarm-gateway --> Bee light node
   |--JSON-RPC (anon-rpc transports)--> Ethereum node   (chain reads fallback, and all wallet writes)
```

### Static frontend

- `apps/web` uses `output: "export"`. Every route is pre-rendered; the token page is a single
  static route that reads the address from the query string, so no route depends on a server.
- All asset references are relative so the same files work under a subdomain gateway and a
  `/bzz/<ref>/` path gateway. Binary files ship only as optimised assets under `assets/`
  (`pnpm --filter @verada/web assets` writes them to `public/assets/` from `apps/web/assets-src/`):
  `.webp`, `.avif`, `.svg`, `.woff2` or `.png`, at most 400 KB each (100 KB for `.png`) and 5 MB in
  total. `verify:export` and the publish tool both enforce this budget and reject binaries anywhere
  else.
- Large or growing art sets (stock logos, later art packs) stay out of the bundle. The same script
  builds them into `apps/web/packs/<name>/` (not tracked) with an `index.json`;
  `verada-publish upload-pack --dir apps/web/packs/<name>` uploads each once as its own Swarm
  collection, and the app loads it from `<swarmGatewayUrl>/bzz/<ref>/` like token logos, using the
  reference in config.json `assetPacks` (`NEXT_PUBLIC_STOCK_LOGOS_REF` for stocks). Packs have only
  the per-file limit and are not re-uploaded with each site release.
- `verify:export` expands dynamic segments against the built directories (at least one per level,
  each with an `index.html`) and requires `agent/<ensLabel>/` and `agent/<ensLabel>/<region>/` for
  every curator agent and region, read from the SDK's `catalog.ts`, with nothing extra under
  `agent/`.
- Runtime settings (indexer URLs, RPC URL, chain id, contract addresses) come from `config.json` in
  the bundle, with build-time defaults from `NEXT_PUBLIC_*`. They are public values; no secrets.
  Changing indexer URLs therefore needs a new Swarm reference and a contenthash update.
- Swarm content is immutable per reference. A release is: build, validate, upload, append the new
  reference to the site feed (`verada-publish feed-update`). The contenthash points at the feed
  manifest and does not change. The previous reference stays addressable while its stamp lasts.

### Swarm and ENS contenthash

- `packages/publish` validates the export, estimates stamp depth and cost, uploads through a Bee
  node (only with `--execute`), and encodes the reference as an ENS contenthash.
- Encoding is ENSIP-7 / EIP-1577 for Swarm: `0xe40101fa011b20` followed by the 32-byte reference
  (swarm-ns, CIDv1, swarm-manifest, keccak-256, 32 bytes). The tool prints the exact calldata, either
  `TokenProfileRegistry.setDefaultContenthash(bytes)` for the Verada resolver or
  `setContenthash(bytes32,bytes)` for a standard resolver; it never signs or sends it.
- Postage stamps (xBZZ on Gnosis Chain) and the ENS transaction are paid by the operator. Content
  expires when its stamp does, so the batch must be topped up.
- The `publish-swarm` workflow only builds, validates and attaches the export as a build artifact.
  It holds no keys, stamp or ENS credentials; upload and the contenthash update are manual.

### Indexer API

The indexer exposes JSON over HTTPS with CORS, cursor pagination and bigint values as decimal
strings: `/health`, `/api/tokens` (rows now carry `name`, `symbol` and the ENS profile columns
`label`, `controller`, `editor`, `logoRef`, `contenthash`, `suppressed`), `/api/tokens/:address`
(plus `profile` with text records, `shortlist` (pinned causes) and `focus`), `/api/tokens/by-label/:label`,
`/api/activity` (filterable, newest first; kinds include `token_registered`, `profile_updated`,
`epoch_opened`, `epoch_closed`, `takeover_proposed`, `takeover_executed`, `tally_submitted`),
`/api/activity/stream` (Server-Sent Events with `Last-Event-ID` resume), `/api/causes`,
`/api/causes/search` (cached server-side proxy of Endaoment search, never returning image URLs),
`/api/epochs/:token[/:epoch]` (with the frozen `options`, the scheme `poll` state and counts, `start`,
`end`, `snapshot`; the single-epoch route also returns `pinnedCount`, `curatedDrawn` and
`curatedCount` (curated picks checked and placed, from `CuratedPicksUsed`; null until the ballot is
prepared, 0 when it was prepared without any) and `optionSources`, one entry per option in ballot
order: `pinned`, `curated` or `rotation`, or null until the ballot is prepared), `/api/takeovers/:token[/:id]` (proposals with a derived `state`),
`/api/polls/:governor/:token/:scope` and `/api/stats` (USDC totals, 6 decimals). There is no route
keyed by voter address.

### Data flow

1. Contracts emit events on mainnet. The indexer ingests them over RPC into Postgres.
2. The browser loads the static bundle from Swarm, reads `config.json`, and calls the indexer for
   lists, activity, causes and stats, and subscribes to the activity stream.
3. If the indexer is unreachable, the app falls back to reading the chain directly through
   wagmi/viem for the core views, using the configured RPC.
4. Writes (launch, vote, donate) are transactions from the user's wallet; the indexer is read-only
   from the browser's point of view.
5. The cause picker queries the indexer's Endaoment proxy, so the browser never calls Endaoment or
   loads its images.

### CORS and gateways

The indexer only answers listed origins (`indexerCorsOrigins` in CDK, `CORS_ALLOWED_ORIGINS` in the
service). A Swarm site is served from the origin of whichever gateway is used, for example an
ENS-gateway hostname for the name, so each gateway origin you intend to support must be listed.
Production does not allow `*`. The API is rate limited per client.

### Intentionally not decentralised yet

- The indexer is a single operator-run AWS service. It is a convenience and performance layer, not
  a source of truth: the chain is, and the frontend can read it directly. Anyone can run their own
  indexer and point `config.json` at it (multiple indexer URLs are tried in order).
- The ENS name is controlled by one account, which decides what the contenthash points to.
- Postage stamps are bought and renewed by the operator; availability depends on them.
- Gateways used to open the ENS name are third-party; users who run their own Bee node and ENS
  resolution avoid them.
- RPC access defaults to one configured endpoint.
- The Endaoment search proxy is operated by the indexer host.
- Curator agents are platform-run: one account's scheduled routines and one key custodian (1Claw),
  and only the registry owner can register or replace a signer. Pins and rotation keep every
  ballot working without them.
- Mainnet x402 settlement runs through the platform's own facilitator in the publisher.

## AWS topology

Defined in `infra/` with CDK (TypeScript). The indexer, the Bee node with its gateway and the
publisher live on AWS; there are no web hosting resources (no S3 site bucket, CloudFront or web
service).

| Stack | Resources |
|---|---|
| `NetworkStack` | VPC across two availability zones with a no-NAT default network and optional private egress. |
| `DataStack` | PostgreSQL for the indexer: RDS (dev default) or Aurora Serverless v2 (prod default), credentials in Secrets Manager. |
| `IndexerStack` | ECR repository, ECS Fargate service behind an Application Load Balancer that must terminate HTTPS, autoscaling, log groups. |
| `SwarmStack` | Bee light node (`ethersphere/bee`) with its data directory on EFS plus `swarm-gateway` (public reads, authenticated uploads) behind an HTTPS ALB. |
| `PublisherStack` | ECR repository and Fargate service for `services/publisher` behind an HTTPS ALB. |
| `ObservabilityStack` | Alarms and a dashboard for the services and database. |

Stack ids are `Verada-<env>-<Name>`. Configuration comes from CDK context and Secrets Manager; no
secrets live in code, and IAM is least-privilege. `cdk synth` runs offline in CI with dummy context.

## CI and deployment

- `.github/workflows/ci.yml`: Foundry format, build and test; pnpm install, typecheck and test; a
  static export job (publish tool tests, web tests, export build, export validation, upload dry run
  that sends nothing); an infra job (typecheck, jest, `cdk synth` with dummy context and no AWS
  credentials); and an asset placement check: binary files are tracked only in
  `apps/web/assets-src/` (originals, never published) and `apps/web/public/assets/` (optimised
  copies from `pnpm --filter @verada/web assets`, the only art that reaches Swarm).
- `.github/workflows/deploy-aws.yml`: manual dispatch. Deploys only the network, data, indexer and
  observability stacks for a chosen environment name. It assumes an AWS role through GitHub OIDC
  (no long-lived keys) and needs the repository variables `AWS_ACCOUNT_ID`, `AWS_REGION` and
  `AWS_DEPLOY_ROLE_NAME`, plus non-secret settings such as the indexer domain or certificate,
  allowed CORS origins and contract addresses.
- `.github/workflows/publish-swarm.yml`: manual dispatch. Builds and validates the static export and
  attaches it (with the dry-run report) as a build artifact. It has read-only repository access, no
  secrets, and never uploads to Swarm or touches ENS.
