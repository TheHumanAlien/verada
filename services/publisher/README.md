# @verada/publisher

Small Hono service (Node 22) that uploads token logos and metadata to Swarm through Verada's
swarm-gateway, reports postage status, and runs background jobs that mirror public records onto
Arkiv. It is the only Verada server that accepts writes, so it keeps no state and logs no request
bodies, file names, IPs or addresses (see `docs/PRIVACY.md`).

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | | `{ status: "ok", uploads }` (`uploads` is false until the gateway, batch and public gateway are configured) |
| POST | `/uploads/logo` | `multipart/form-data`, field `file` | `201 { reference, bzz: "bzz://<ref>", url: "<PUBLIC_GATEWAY_URL>/bzz/<ref>/" }` |
| POST | `/uploads/metadata` | `application/json`, a `TokenMetadata` document | `201 { reference, uri: "bzz://<ref>", url }` |
| GET | `/site` | | `{ gateway, batchId, stamp: { usable, batchTTL, ttlDays, utilization, utilizationRatio, depth, bucketDepth, amount, immutable } \| null, feedOwner?, feedManifest?, stampError? }` |

Logo rules: the type is detected from magic bytes only (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG
`FF D8 FF`, WebP `RIFF....WEBP`). The client's declared type and file name are ignored. SVG and
everything else get `415`, files over `MAX_LOGO_BYTES` get `413`. Logos are stored as `logo.png`,
`logo.jpg` or `logo.webp` with the sniffed content type.

`TokenMetadata` (strict, so unknown keys get `400`): `name` (1–64), `symbol` (1–16, letters, digits,
`$._-`), `description?` (≤ 2000), `logoRef` (64 hex, lowercased), `website?` (http(s) URL ≤ 256),
`twitter?`, `telegram?` (≤ 64, no whitespace or quotes), `discord?` (≤ 256), `launcher?` (address,
checksummed; the only address the document may carry, and only if the creator includes it). The
document is stored as canonical JSON (keys sorted, no whitespace), named `metadata.json`, so the same
metadata always gives the same reference.

Errors are JSON `{ error }`: `400 invalid_request` (with `issues`), `405`, `413 payload_too_large`,
`415 unsupported_media_type`, `429 rate_limited` (`Retry-After`), `502 upstream_unavailable`,
`503 uploads_unavailable`.

Uploads call `POST {BEE_GATEWAY_URL}/bzz?name=<file>` with `Authorization: <BEE_GATEWAY_AUTH_SECRET>`
(sent as is: swarm-gateway compares the header to its `AUTH_SECRET` exactly, so do not add `Bearer `
unless the gateway's secret includes it), `Content-Type`, `swarm-postage-batch-id`, `swarm-pin: true`,
`swarm-deferred-upload: false`. Encrypted (128-hex) references are refused.

## How the launch form uses it

1. The creator picks a logo. The form posts it to `/uploads/logo` and shows `url` as a preview.
2. The form posts `{ name, symbol, description, logoRef: <reference from step 1>, website, ... }` to
   `/uploads/metadata`.
3. The launch transaction uses `uri` as the token's metadata URI and `swarmReferenceToBytes32(logoRef)`
   as the on-chain logo reference.

The form needs nothing from the wallet for these calls. Only the optional `launcher` field ties an
address to the upload, and the form should leave it out unless the creator asks for it.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `42070` | |
| `BEE_GATEWAY_URL` | none | swarm-gateway base URL (internal) |
| `BEE_GATEWAY_AUTH_SECRET` | none | secret, sent as the `Authorization` header |
| `BEE_STAMPS_URL` | `BEE_GATEWAY_URL` | serves `GET /stamps/{batchId}`. swarm-gateway does not proxy `/stamps`, so point this at the Bee API (port 1633, internal only) |
| `SWARM_BATCH_ID` | none | secret, 64-hex postage batch id (`0x` optional) |
| `PUBLIC_GATEWAY_URL` | none | gateway browsers read from, e.g. `https://gw.verada.xyz` |
| `INDEXER_URL` | none | public indexer API, read by `arkiv-mirror` |
| `CHAIN_ID` | `1` | Ethereum chain id of the mirrored records |
| `ARKIV_ENABLED` | `false` | turn on the Arkiv jobs |
| `ARKIV_DRY_RUN` | `false` | plan and log Arkiv writes without sending them |
| `ARKIV_CHAIN` | `rabdi` | `rabdi` (testnet) or `localhost` |
| `ARKIV_ACCESS_KEY` | none | secret. It goes in the RPC URL path, so RPC errors are redacted before logging |
| `ARKIV_PRIVATE_KEY` | none | secret, platform signer; its address is the `$creator` readers must trust |
| `ARKIV_RPC_URL` | chain default | override |
| `CORS_ALLOWED_ORIGINS` | any | comma list: exact origins or `*.` suffixes, optionally scheme-qualified (`https://*.eth.limo`) |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | `1` / `20` | per-IP token bucket on `/uploads/*` and `/site` (in memory only) |
| `TRUST_PROXY_HOPS` | `1` | trusted proxies in `X-Forwarded-For` (ALB = 1) |
| `MAX_LOGO_BYTES` | `2097152` (2 MiB) | |
| `MAX_METADATA_BYTES` | `65536` (64 KiB) | |
| `JOB_INTERVAL_SECONDS` | `60` | mirror interval; `stamp-watch` runs at most every 10 min, `arkiv-extend` at most hourly |
| `SITE_FEED_OWNER`, `SITE_FEED_MANIFEST` | none | passed through by `GET /site` |
| `KEEPER_ENABLED` | `false` | turn on the tally keeper (see "Tally keeper") |
| `KEEPER_DRY_RUN` | `false` | estimate and log keeper transactions; never decrypt or send |
| `KEEPER_PRIVATE_KEY` | none | secret, keeper signer (0x + 32 bytes); needs ETH for gas only |
| `ETH_RPC_URL` | none | secret, Ethereum RPC URL or comma list (viem fallback, JSON-RPC batching) |
| `EPOCH_GOVERNOR_ADDRESS`, `VOTING_SCHEME_ADDRESS`, `TAKEOVER_GOVERNOR_ADDRESS` | none | required by the keeper; the scheme is the `ZamaVotingScheme` it decrypts for |
| `FACTORY_ADDRESS`, `FACTORY_DEPLOY_BLOCK` | none | keeper token discovery fallback (`TokenCreated` logs) when the indexer is down; both needed |
| `KEEPER_MAX_TX_PER_RUN` | `10` | transactions per run (dry run: planned transactions) |
| `KEEPER_LOOKBACK_EPOCHS` | `4` | epochs `[current - n, current)` checked per token |
| `KEEPER_INTERVAL_SECONDS` | `300` | keeper run interval |
| `ZAMA_RELAYER_URL` | chain preset | override of the Zama relayer (`https://relayer.mainnet.zama.org`) |
| `ZAMA_RELAYER_API_KEY` | none | secret, Zama relayer API key (API-key header). Required on mainnet |

Invalid configuration fails start-up with the variable names only, never their values.

## Jobs

Each job runs on its own interval, once shortly after start, never overlapping itself, and only when
its configuration is present.

- `arkiv-mirror` (`ARKIV_ENABLED`, `ARKIV_PRIVATE_KEY`, `INDEXER_URL`): reads `/api/tokens` (all pages)
  and `/api/causes`, reads the platform's entities from Arkiv, runs `planReconcile`, and applies the plan
  with `@verada/arkiv-registry`. Idempotent: an unchanged indexer gives no writes. At most 50 new tokens
  per run.
- `arkiv-extend` (`ARKIV_ENABLED`, `ARKIV_PRIVATE_KEY`): extends every platform entity expiring within 30
  days to the maximum lifetime (about 182 days).
- `stamp-watch` (`BEE_GATEWAY_URL`, `SWARM_BATCH_ID`): logs `postage batch needs attention` at `warn` when
  `batchTTL` is under 30 days, utilization is over 70% or the batch is unusable. Alarm on that message.
- `tally-keeper` (`KEEPER_ENABLED`, `KEEPER_PRIVATE_KEY`, `ETH_RPC_URL`, the three governance addresses):
  see below.

## Tally keeper

Ballots on `ZamaVotingScheme` are encrypted, so an epoch or takeover poll only ends once someone
closes it, relays the public decryption of its tallies, and finalizes it. All of those calls are
permissionless; the keeper makes them so nobody has to. Code: `src/jobs/tally-keeper.ts` and
`src/keeper/` (`plan.ts` holds every decision as a pure function).

**Flow.** Each run reads everything from chain state, so runs are idempotent and a restart loses only
backoff timers.

1. Takeovers, ids `1..proposalCount` (first, because of the execution window), by `state(id)`:
   `Closing` and not closed: `closeProposal`. Closed and the scheme tally not final: decrypt and
   `submitTally(takeoverGovernor, token, id, ...)`. Tally final, not tallied: `recordTally`.
   `Succeeded`: `execute`. `Active` waits; `Defeated`, `Executed`, `Canceled`, `Expired` are
   never read again.
2. The current epoch's ballot, for every registered token, when it is not prepared. Ballots are
   rejected until the epoch is opened, and nothing opens it but this step (or a volunteer). When
   the ballot needs rotation draws (pins do not fill it and the focus pool is not empty) the keeper
   computes them with the SDK's `planRotation` (the governor's algorithm), fetches those entries
   and their Merkle proofs from the indexer's `/api/catalog/entries`, refuses them unless the
   indexer's root is the on-chain root of the epoch's catalogue version, and sends
   `prepareBallot`; otherwise it sends `openEpoch`. Needs `INDEXER_URL`.
3. Epochs, for every token (indexer `/api/tokens`, all pages; `TokenCreated` logs of `FACTORY_ADDRESS`
   from `FACTORY_DEPLOY_BLOCK` when the indexer fails) and every epoch in
   `[current - KEEPER_LOOKBACK_EPOCHS, current)`, skipping unregistered tokens and finalized epochs:
   - never opened, or opened with `voterCount == 0`: `finalizeEpoch` (the default cause wins; the
     epoch is not closed, which saves a public decryption);
   - opened with ballots, not closed: `closeEpoch` (makes the tallies publicly decryptable);
   - closed, `tallyOf` not final: `tallyHandles` → Zama `publicDecrypt` → `submitTally`;
   - closed, tally final: `finalizeEpoch`.

   An item takes up to four steps in one run (close → submit → finalize), re-reading state before
   each. Polls on a scheme other than `VOTING_SCHEME_ADDRESS` are never decrypted.

**Decryption.** `@zama-fhe/sdk` (Node transport over `@fhevm/sdk`, loaded lazily, no signer):
`sdk.decryption.decryptPublicValues(handles)` returns `{ clearValues, abiEncodedClearValues,
decryptionProof }`. The keeper checks that `abiEncodedClearValues` is one 32-byte word per handle,
each within `uint64` and equal to that handle's clear value, then submits those bytes unchanged
(the KMS signed exactly them, in handle order). The first decryption also fetches the FHE public key
(about 50 MB) and loads WASM, so give the task headroom (1 GiB or more).

**Transactions.** One viem wallet client and one account, one transaction at a time: gas estimate
(a revert here costs nothing), send with 120% of the estimate, wait for the receipt. At most
`KEEPER_MAX_TX_PER_RUN` per run. A send or receipt failure stops the run so no second nonce is
used while one may be pending. Run a single publisher task.

**Failure handling.** A failed step backs its item off in memory: 5 min, doubling to 6 h, reset on
success. Failures log `keeper step failed` at `error` with the item, the step and the decoded revert
name (never its arguments) or a redacted message (no URLs, no addresses). Alarm on `error` lines
whose msg starts with `keeper`/`tally keeper` and on `job tally-keeper failed` (whole run failed,
e.g. RPC down). The one expected failure, `NoVotes` (an epoch without ballots while no default
cause is set), logs at `warn`: the owner fixes it with `EpochGovernor.setDefaultCause`, and the
backoff keeps it from retrying every run. `keeper reached its per-run transaction cap` (warn) means
the backlog exceeds the cap; it drains over the next runs. Each run ends with `tally keeper run`
(counts: txs, decrypted, failed, backedOff, capped, halted).

**Funding.**
- ETH on the keeper account for gas. Rough costs: `closeEpoch`/`closeProposal` call the scheme's
  `requestTally` (one ACL write per option), `submitTally` verifies KMS signatures on-chain
  (`FHE.checkSignatures`), `finalizeEpoch` loops over at most 32 options and materializes the winner, `prepareBallot` (about
  1.5M gas for a 32-option ballot) stores the options and opens the poll. Measure on a mainnet fork or with
  `scripts/zama-e2e.ts`; budget `KEEPER_MAX_TX_PER_RUN` transactions per run at peak. Every
  registered token gets a `finalizeEpoch` each week, ballots or not.
- Zama protocol fees: public decryption is priced in USD and paid in $ZAMA by the relayer account
  (the account behind `ZAMA_RELAYER_API_KEY` on Zama's relayer, or your own relayer when
  `ZAMA_RELAYER_URL` points at one). The keeper account holds no $ZAMA. Keep that relayer account
  funded; one decryption per closed poll that had ballots (epochs without ballots are never
  decrypted). Unfunded or unauthorized relayer requests show up as `op: "decrypt"` errors.

**Privacy.** The keeper never reads voters or ballots. Logs carry token addresses, epochs,
proposal ids, option counts, tx hashes and the keeper's own address.

**Rollout.** Start with `KEEPER_ENABLED=true KEEPER_DRY_RUN=true` and check the `keeper dry run`
lines (planned transaction, gas estimate; decryption is skipped), then turn dry run off.

**Manual mainnet check** (spends real gas and Zama fees; try `E2E_DRY_RUN=true` first) of the decrypt + submit path for one closed poll:

```sh
ETH_RPC_URL=... KEEPER_PRIVATE_KEY=0x... VOTING_SCHEME_ADDRESS=0x... \
E2E_GOVERNOR=0x... E2E_TOKEN=0x... E2E_SCOPE=<epoch or proposal id> \
pnpm --filter @verada/publisher e2e:zama
# optional: ZAMA_RELAYER_URL, ZAMA_RELAYER_API_KEY, E2E_DRY_RUN=true (decrypt and estimate only)
```

Opening and voting on a poll is out of scope: close it first (`closeEpoch` after the epoch ends, or
`closeProposal` after `end`). The script prints the handle count, decryption time, the decrypted
totals, the gas estimate, then the `submitTally` hash, status and `gasUsed`.

## Ops notes

- **Stamps.** Use an immutable batch for site feeds: a mutable batch overwrites the oldest chunks when
  full, which silently breaks old feed updates and uploads. Keep `batchTTL` above 30 days by topping up,
  and dilute (raise the depth) before utilization passes 70%. `GET /site` and `stamp-watch` report both.
- **Arkiv is testnet only** (Rabdi). Entities expire after at most about 182.5 days unless extended, and
  the testnet may be reset. The mirror is a convenience copy; Ethereum and Swarm stay the source of
  truth. Fund the platform signer with tGLM from https://hub.arkiv.network/faucet. Start with
  `ARKIV_DRY_RUN=true` and check the planned writes in the logs.
- **One task.** Run a single instance: the Arkiv signer and the keeper each use one nonce sequence.
- **Privacy.** No access logs. Logs carry Swarm references, sizes, entity keys and token addresses, never
  IPs, file names, bodies or secrets.

## Build and run

```sh
pnpm --filter @verada/publisher test
pnpm --filter @verada/publisher typecheck
pnpm --filter @verada/publisher dev        # tsx watch src/index.ts

# Image (build context: repository root)
docker build -f services/publisher/Dockerfile .
```
