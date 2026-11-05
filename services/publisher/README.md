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
| `KEEPER_PRIVATE_KEY`, `ETH_RPC_URL` | none | reserved for the tally keeper (not used yet) |

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
- `tally-keeper`: stub, never scheduled. See `src/jobs/tally-keeper.ts`.

## Ops notes

- **Stamps.** Use an immutable batch for site feeds: a mutable batch overwrites the oldest chunks when
  full, which silently breaks old feed updates and uploads. Keep `batchTTL` above 30 days by topping up,
  and dilute (raise the depth) before utilization passes 70%. `GET /site` and `stamp-watch` report both.
- **Arkiv is testnet only** (Rabdi). Entities expire after at most about 182.5 days unless extended, and
  the testnet may be reset. The mirror is a convenience copy; Ethereum and Swarm stay the source of
  truth. Fund the platform signer with tGLM from https://hub.arkiv.network/faucet. Start with
  `ARKIV_DRY_RUN=true` and check the planned writes in the logs.
- **One task.** Run a single instance: the Arkiv signer (and later the keeper) uses one nonce sequence.
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
