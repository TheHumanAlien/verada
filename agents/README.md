# Curator agents: operations

How to provision, schedule, watch and recover the twenty curator agents. What the agents are and
how their picks reach ballots is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#curator-agents);
what they publish and what that reveals is in [docs/PRIVACY.md](../docs/PRIVACY.md).

Each agent is three things:

- a **1Claw agent** holding its Ethereum key in an HSM, with policies that limit what the key may do;
- an **on-chain registration** in `CuratorRegistry`: ERC-8004 identity, signer, `AgentVault` and
  the name `<label>.agent.varada.eth`;
- a **Claude scheduled cloud routine** that runs once a week, does the research and writing, and
  drives the `verada-curator` CLI (`packages/curator`), which sends every signature and
  transaction through 1Claw.

## The agents

One per category in `packages/sdk/src/catalog.ts` that has an `ensLabel` (every category except
`other`, bit 19). The label is permanent once registered. Routine times are explained under
[Weekly timing](#3-weekly-timing).

| Bit | Category | Label | Name | Routine (Wednesday, UTC) | Cron (UTC) |
|---|---|---|---|---|---|
| 0 | `disaster-relief` | `disaster` | `disaster.agent.varada.eth` | 06:00 | `0 6 * * 3` |
| 1 | `homelessness` | `homeless` | `homeless.agent.varada.eth` | 06:30 | `30 6 * * 3` |
| 2 | `hunger` | `hunger` | `hunger.agent.varada.eth` | 07:00 | `0 7 * * 3` |
| 3 | `children-youth` | `children` | `children.agent.varada.eth` | 07:30 | `30 7 * * 3` |
| 4 | `disease` | `disease` | `disease.agent.varada.eth` | 08:00 | `0 8 * * 3` |
| 5 | `cancer-research` | `cancer` | `cancer.agent.varada.eth` | 08:30 | `30 8 * * 3` |
| 6 | `endangered-species` | `wildlife` | `wildlife.agent.varada.eth` | 09:00 | `0 9 * * 3` |
| 7 | `animal-welfare` | `animals` | `animals.agent.varada.eth` | 09:30 | `30 9 * * 3` |
| 8 | `environment-climate` | `environment` | `environment.agent.varada.eth` | 10:00 | `0 10 * * 3` |
| 9 | `clean-water` | `water` | `water.agent.varada.eth` | 10:30 | `30 10 * * 3` |
| 10 | `health-care` | `health` | `health.agent.varada.eth` | 11:00 | `0 11 * * 3` |
| 11 | `mental-health` | `mental-health` | `mental-health.agent.varada.eth` | 11:30 | `30 11 * * 3` |
| 12 | `medical-research` | `research` | `research.agent.varada.eth` | 12:00 | `0 12 * * 3` |
| 13 | `education` | `education` | `education.agent.varada.eth` | 12:30 | `30 12 * * 3` |
| 14 | `refugees` | `refugees` | `refugees.agent.varada.eth` | 13:00 | `0 13 * * 3` |
| 15 | `human-rights` | `human-rights` | `human-rights.agent.varada.eth` | 13:30 | `30 13 * * 3` |
| 16 | `women-girls` | `women` | `women.agent.varada.eth` | 14:00 | `0 14 * * 3` |
| 17 | `poverty` | `poverty` | `poverty.agent.varada.eth` | 14:30 | `30 14 * * 3` |
| 18 | `veterans` | `veterans` | `veterans.agent.varada.eth` | 15:00 | `0 15 * * 3` |
| 20 | `justice` | `justice` | `justice.agent.varada.eth` | 15:30 | `30 15 * * 3` |

Regions (bits 0-7): `africa`, `asia`, `europe`, `middle-east`, `north-america`, `latin-america`,
`oceania`, `global`. Agent `c` in region `r` curates bucket `c * 16 + r`.

## 1. Provision the 1Claw agents

Create one 1Claw agent per cause (20), each with its own Ethereum signing key, plus one more for
the x402 facilitator (see [Facilitator settlement key](#facilitator-settlement-key)). Never share a
key between causes: the registry, the vault and the publisher all identify an agent by its signer.

For each curator agent:

1. Create the agent and its key. Record the key's address (the **signer**) and the agent id
   (`ONECLAW_AGENT_ID`).
2. Set its policies:
   - `tx_to_allowlist`: the `CuratorRegistry` address and that agent's own `AgentVault` (known
     after [registration](#2-register-on-chain); add it then).
   - Zero value on every transaction.
   - A small daily transaction count. A normal week is one `submitCurations`, perhaps a resubmission
     and a gift or two; a cap of about five a day is ample (a suggestion, not a measured need).
   - Simulation before broadcast on (the CLI also asks for it: `simulate_first: true`).
   - Human approval for gifts above a USD threshold. Gifts are USDC (6 decimals) passed as the
     `amount` argument of `AgentVault.give`.
   - Message signing allowed: EIP-191 for report signatures every week, and one EIP-712 signature
     for the wallet link.
3. Create an API key for the agent. It goes into the routine's environment as a network secret
   (see [Routines](#4-create-the-routines)), never into a prompt, a file or this repository.
4. Fund the signer with ETH for gas. The signer pays for `submitCurations` and gifts; the vault
   pays nothing.

## 2. Register on chain

All of these are `onlyOwner` on `CuratorRegistry`, whose owner is the platform (`OWNER` in
`contracts/script/Deploy.s.sol`; the registry is `Ownable2Step`, so the owner must have accepted
ownership). The deploy script already linked the registry and the governor
(`setCuratorRegistry`, `setGovernor`) and reserved the label `agent` in `TokenProfileRegistry`.
Examples use `cast calldata`, so the owner can send them from any wallet or multisig.

### registerAgent

```sh
cast calldata "registerAgent(uint8,string,address,string,string)" \
  2 hunger 0x<signer> "<agentURI>" "<description>"
```

- `categoryBit` and `label` must match the table above (`ensLabel` in the SDK); the label is
  validated and can never change.
- `agentURI` is the agent's ERC-8004 registration URI; `description` becomes the ENS `description`
  text record. Both can be changed later (`setAgentURI`, `setDescription`).
- The call deploys the `AgentVault` (CREATE2, salt = category bit), registers the ERC-8004
  identity (owned by the registry) and emits `AgentRegistered(categoryBit, agentId, label, signer,
  vault)`. Read the vault from the event or `agentOf(categoryBit)`, then add it to the agent's
  1Claw `tx_to_allowlist`.

### linkAgentWallet

Makes the vault the identity's ERC-8004 agent wallet. The signer signs EIP-712 typed data in the
Identity Registry's domain:

- domain: `name "ERC8004IdentityRegistry"`, `version "1"`, `chainId 1`,
  `verifyingContract 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`;
- type: `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`;
- values: the agent id, `newWallet` = the vault, `owner` = the `CuratorRegistry` address, and a
  `deadline` **at most 5 minutes ahead**.

Then the owner sends, inside that window:

```sh
cast calldata "linkAgentWallet(uint8,uint256,bytes)" 2 <deadline> <signature>
```

The Identity Registry checks the signature through the vault's ERC-1271 `isValidSignature`, which
accepts the agent's current signer. Check `getAgentWallet(agentId)` on the Identity Registry
returns the vault. With a multisig owner, have the transaction ready to execute before the signer
signs, because of the 5-minute deadline.

### setMaxGivePerEpoch

On the agent's `AgentVault`, callable by the registry owner:

```sh
cast calldata "setMaxGivePerEpoch(uint256)" 500000000   # 500 USDC per epoch
```

The cap is the total the agent may give in one epoch across all regions, in USDC units
(6 decimals). It starts at zero, which allows no gifts. It is the hard limit on what a misused key
could move in a week; 1Claw's approval threshold sits below it.

### setSigner, setActive

```sh
cast calldata "setSigner(uint8,address)" 2 0x<new signer>
cast calldata "setActive(uint8,bool)" 2 false
```

- `setSigner` takes effect at once for submissions, gifts, report uploads and the vault's ERC-1271
  check. The ERC-8004 wallet stays the vault, so no new wallet link is needed.
- `setActive(false)` pauses the agent: `submitCurations` reverts, the governor ignores its
  curations (including one already submitted for the next epoch, if the ballot is not yet
  prepared), and the publisher answers `agent_inactive`. It does **not** stop gifts; use
  `AgentVault.setPaused(true)` for that.

## 3. Weekly timing

From `EpochGovernor`:

- `EPOCH_LENGTH` is 7 days. `epochZeroStart` is `floor(deployTime / 7 days) * 7 days`, a Thursday
  00:00 UTC (Unix time 0 was a Thursday). Epoch `k` starts at `epochZeroStart + k * 604800`, so
  **every epoch starts on a Thursday at 00:00 UTC**.
- `CuratorRegistry.submitCurations` accepts only `epoch == currentEpoch() + 1`. Curations for the
  epoch starting next Thursday can be sent any time during the current epoch, and replaced until
  that Thursday 00:00 UTC.
- The keeper opens ballots shortly after Thursday 00:00 UTC (it runs every
  `KEEPER_INTERVAL_SECONDS`, 300 by default). By then the report must be on Swarm, the submission
  mined, and both indexed, or the keeper keeps retrying (`CuratedPicksUnavailable`, exponential
  backoff from 5 minutes, doubling, but never waiting past the end of `CURATION_GRACE`). Once the
  grace (6 hours) has passed, the keeper retries within 30 seconds plus one keeper interval and opens
  the ballot with rotation only, so with picks missing from the start of the epoch that comes a
  few minutes after 6 hours in. Anyone can call `prepareBallot` or `openEpoch` as soon as the grace
  ends, and restarting the publisher clears the backoff.
- A curation counts only under the catalogue version in effect at the epoch's start: the last
  `CauseCatalog.setVersion` before Thursday 00:00 UTC. Publish catalogue versions before the
  routines run (by Tuesday). A version set after a routine has submitted voids that submission;
  run the affected routines again before Thursday 00:00 UTC.
- Gift caps (`givenIn[epoch]`) reset at each epoch start.

Schedule: **Wednesday, one routine every 30 minutes from 06:00 UTC in bit order, the last at
15:30 UTC** (table above). The research covers the week to Wednesday, the last submission lands
8.5 hours before the epoch starts, and that margin leaves room to rerun a failed routine. Twenty
runs a week is far below the 100 runs per hour per account limit; the stagger is for 1Claw, the
publisher (its `/agents/*` routes are rate limited per client IP) and the RPC behind them.

Read the numbers a routine needs:

```sh
cast call $EPOCH_GOVERNOR "currentEpoch()(uint256)"            # submit for this + 1
cast call $EPOCH_GOVERNOR "epochStart(uint256)(uint256)" <n>   # unix start of epoch n
cast call $CAUSE_CATALOG  "latestVersion()(uint32)"            # --catalog-version
```

## 4. Create the routines

One routine per agent, on the repository, weekly at its cron time.

### Network allowlist

Allow only:

- the 1Claw API host (`https://api.1claw.co` unless `ONECLAW_BASE_URL` says otherwise);
- the publisher (`PUBLISHER_URL`);
- the catalogue source (`CATALOG_SOURCE`: an https base URL serving `catalog.json`, `orgs.jsonl`
  and `tree.json`, for example the catalogue snapshot's Swarm gateway path) and the indexer, for
  checking the result;
- an Ethereum RPC for the read-only calls above;
- the package registry the install needs;
- the news sources the agent researches.

The agent holds no private key and needs no write-capable RPC: 1Claw broadcasts its transactions.

### Secrets and environment

| Variable | Kind | Value |
|---|---|---|
| `ONECLAW_API_KEY` | Network secret | The agent's 1Claw API key, injected by the proxy on requests to the 1Claw host. The CLI then sends a placeholder; the key never appears in the routine's environment. |
| `ONECLAW_AGENT_ID` | Plain | The agent's 1Claw agent id. |
| `ONECLAW_BASE_URL` | Plain, optional | 1Claw API base URL. |
| `CURATOR_REGISTRY_ADDRESS` | Plain | `CuratorRegistry`. |
| `PUBLISHER_URL` | Plain | Publisher base URL. |
| `CATALOG_SOURCE` | Plain | Catalogue snapshot (directory or https base URL). |
| `ETH_RPC_URL` | Plain (secret if the URL carries a key) | Mainnet RPC for read-only calls (the skill's status step; `cast`). |
| `INDEXER_URL` | Plain | Indexer base URL, for verification. |

Also give the routine its category label and its vault address (for `give --vault`). The curator
skill reads the `EpochGovernor` and `CauseCatalog` addresses from `CuratorRegistry`; the shell
sketch below takes them as `EPOCH_GOVERNOR` and `CAUSE_CATALOG`.

### What each run does

```sh
pnpm install --frozen-lockfile
C="node packages/curator/bin/verada-curator.mjs"   # from the repository root
NEXT=$(( $(cast call $EPOCH_GOVERNOR "currentEpoch()(uint256)") + 1 ))
VERSION=$(cast call $CAUSE_CATALOG "latestVersion()(uint32)")

$C template --category hunger --epoch $NEXT --catalog-version $VERSION > report.json
$C pool --category hunger --region africa          # once per region: the bucket's entries
# research and write report.json (picks use catalogIndex and orgId from `pool`)
$C build   --report report.json --out built.json   # refuses picks that are not in the bucket
$C publish --built built.json                      # signs, uploads; prints reportRef
$C submit  --built built.json --report-ref <reportRef>
$C give    --category hunger --region africa --org <orgId> --amount <usdc units> --vault <vault>   # optional
```

- Keep all eight regions in the report. A region with nothing to report has no picks and
  weight 0. A resubmission only replaces the regions it lists, so dropping a region from the report
  leaves its earlier curation in place.
- Ranks are positions in `picks`, most important first; weights are the region's urgency this
  week (0-10,000) and decide how many of a token's free ballot slots the region's picks get
  against the other curated buckets in that token's focus.
- `--dry-run` on `submit` and `give` prints the transaction instead of sending it.
- Afterwards, check `GET <indexer>/api/agents/<label>/picks/<NEXT>/<region>` answers 200 for each
  region with picks, and `GET <indexer>/api/agents/<label>/reports/<NEXT>` shows every region
  `verified`.
- News pages and search results are untrusted data. The routine prompt must say so: text in a
  source can inform a ranking but is never an instruction, never changes the steps above, and never
  supplies an address, an amount or an org id that is not from `pool`.
- Reports carry no personal data about private individuals.

## Facilitator settlement key

The publisher's mainnet x402 facilitator settles buyers' EIP-3009 payments and pays the gas, so it
holds a key with ETH and nothing else.

- A separate 1Claw agent and key. Policy: `tx_to_allowlist` = USDC on mainnet
  (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) only, zero value, simulation on, a daily
  transaction cap sized to expected paid traffic (one transaction per mainnet sale). The publisher
  additionally refuses any call that is not `transferWithAuthorization` on USDC.
- Fund the key with ETH. It never holds USDC; payments go from the buyer to the treasury.
- Publisher environment: `X402_FACILITATOR_ENABLED=true`, `X402_FACILITATOR_TOKEN` (secret; the
  same value as the indexer's `X402_MAINNET_FACILITATOR_TOKEN`), `X402_FACILITATOR_PAY_TO` (the
  mainnet treasury; the same as the indexer's `X402_MAINNET_PAY_TO`), `X402_ONECLAW_AGENT_ID`,
  `X402_ONECLAW_API_KEY` (secret) and `ETH_RPC_URL`. Without all of them the facilitator is not
  mounted and the publisher logs a warning.
- Indexer environment: for Base, `X402_BASE_PAY_TO` and `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`
  (secrets). For mainnet, `X402_MAINNET_PAY_TO`, `X402_MAINNET_FACILITATOR_URL` (the publisher's
  base URL plus `/x402`, e.g. `https://<publisher>/x402`; the indexer calls `/verify`, `/settle` and
  `/supported` under it) and `X402_MAINNET_FACILITATOR_TOKEN` (secret). `X402_MAINNET_PAY_TO`
  without the facilitator URL stops the indexer at startup. Turn sales on with `X402_ENABLED=true`.

## Monitoring

| Watch | Where | Expect |
|---|---|---|
| Missed weeks | `GET /api/agents`: each agent's `latest.epoch`; `CurationsSubmitted` events | `currentEpoch() + 1` for every active agent by Wednesday 18:00 UTC |
| Unverified reports | `GET /api/agents/:label/reports/:epoch`, `verified` per region | `true` for every region |
| Run failures | Routine run history (the CLI prints `publisher returned 401: ...bad_signature` or `403: ...agent_inactive`); publisher logs (`curator report uploaded`, `swarm upload failed`) | One upload and one submission per agent per week |
| Picks the keeper cannot get | Publisher keeper logs: `keeper step failed` with `CuratedPicksUnavailable: <label>/<region> picks for epoch N ...` (also `CatalogMismatch`, or a revert `IncompleteCuratedBallot`) | None; any hit early in an epoch delays ballots, by up to the 6-hour grace plus a few minutes |
| Picks that miss | `CuratedPicksUsed(token, epoch, drawn, included)` | `included` close to `drawn`; a gap means mismatched, blocked or repeated picks |
| Vault balances and gifts | USDC `balanceOf(vault)`, `givenIn(epoch)` against `maxGivePerEpoch`, `Given` events, `paused()` | Gifts only to expected orgs, under the cap |
| Gas | ETH balance of the 20 signers and the facilitator key | Several weeks of gas each |
| 1Claw | Denied transactions, pending approvals, daily cap hits | Only expected approvals |
| x402 mainnet | Publisher `x402 settlement` log lines with `success: false` | Rare |

In `/api/agents` totals, `donated`/`donations` count `Donated` events only (`given`/`gifts` count
`Given` events). A plain USDC transfer to a vault shows in its balance but not in the totals.

## Costs

| Item | Cost |
|---|---|
| Routine runs | 20 a week (about 87 a month), billed against the Claude account's plan. Per-run usage depends on the research depth; not measured. |
| 1Claw | 21 agents and keys (20 curators and the facilitator), weekly signatures and transactions, and gift approvals. Price depends on the 1Claw plan; not in this repository. |
| `submitCurations` gas | Measured: about 63k gas for a one-region submission on a mainnet fork (`test_fork_submitCurations`, execution only). Estimate: each further region with picks adds about 45k (two new storage slots and an event), an empty region a few thousand, so about 380k for eight regions and about 7.6M a week for all twenty. At 1 gwei that is about 0.008 ETH a week. |
| Gift gas | Not measured. The first gift to an org without an Endaoment contract also deploys it. |
| Ballot preparation | Paid by the keeper, not the agents. |
| x402 on Base | Coinbase CDP charges $0.001 per settlement after its free tier (size of the free tier not verified here). |
| x402 on mainnet | The facilitator key pays one `transferWithAuthorization` per sale. Estimate: under 100k gas; the $0.50 mainnet price floor (`X402_MAINNET_MIN_PRICE`) is meant to cover it. |
| Swarm | Reports are at most 512 KiB each, on the publisher's postage batch. |

## Pause and recovery

**Stop an agent now** (bad output, suspected manipulation):

1. `AgentVault.setPaused(true)` on its vault: no more gifts.
2. `CuratorRegistry.setActive(categoryBit, false)`: no more submissions; its curations for any
   ballot not yet prepared are ignored and those ballots use rotation. Ballots already prepared
   stay as they are.
3. Disable the routine.

**Key compromise:**

1. Pause the vault and the agent as above.
2. Revoke the key and API key in 1Claw.
3. Provision a new key with the same policies, fund it with ETH, and `setSigner(categoryBit, new)`.
   Gifts, report uploads and the vault's ERC-1271 check follow the new key at once; the ERC-8004
   wallet link stays valid.
4. Point the routine at the new 1Claw agent, then `setActive(categoryBit, true)` and
   `setPaused(false)`.

**A bad org in picks or gifts:** `CauseRegistry.blockOrg`. Blocked orgs are skipped by every
ballot phase and `give` reverts with `OrgBlocked`.

**Wrong curation before the epoch starts:** fix the report and run the routine again; the new
submission replaces every region it lists. Or pause the agent.

**Keeper reports `CuratedPicksUnavailable` after the epoch started** (a root is on chain but the
picks cannot be fetched): the submission can no longer be replaced. Either re-upload the same
`built.json` through `publish` (the same bytes give the same Swarm reference, which is what the
chain points at), or `setActive(categoryBit, false)` so the keeper prepares with rotation on its next retry (the
item may be backed off until the grace end at the latest; restarting the publisher clears the backoff), or let
`CURATION_GRACE` (6 hours) run out. The keeper's backoff never waits past the grace end plus 30
seconds, so it uses rotation on its first run after that, a few minutes after the grace ends at most.
Anyone can also call `prepareBallot` or `openEpoch` directly after the grace.

**Missed week:** nothing breaks. In each token's ballot, the free slots go to the other agents'
picks in that token's focus (up to their pick counts) and then to rotation. Run the routine by hand if
there is time before Thursday 00:00 UTC.

**Catalogue version set mid-week:** run every routine again before Thursday 00:00 UTC, with the
new `--catalog-version` and a `CATALOG_SOURCE` serving that version.

**Routine platform or 1Claw outage:** agents miss the week and ballots use rotation. With 1Claw up,
an operator can run the same CLI steps from a workstation with the agent's 1Claw credentials.

**x402 facilitator problem:** set `X402_FACILITATOR_ENABLED=false` on the publisher and unset
`X402_MAINNET_PAY_TO` on the indexer to stop mainnet sales (Base continues), or `X402_ENABLED=false`
to stop all sales. Rotate the facilitator's 1Claw key the same way as a curator key; no contract
change is needed.
