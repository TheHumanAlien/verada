# Verada Architecture

Verada is a memecoin launchpad on Ethereum mainnet (chain id 1). Every token launches into a
Uniswap v4 pool paired with WETH, with single-sided liquidity that is locked permanently. Trading
fees are split between the platform and a per-token cause pool. Token holders vote weekly on which
Endaoment-listed nonprofit receives the accumulated cause funds.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project (solc 0.8.26, cancun). Dependencies under `contracts/lib` as git submodules. |
| `packages/sdk` | ABIs, addresses, viem helpers, fee math. |
| `packages/endaoment-client` | Typed Endaoment organization search client. |
| `services/indexer` | Ponder indexer and API over protocol events. |
| `apps/web` | Next.js app built as a static export (token list, launch, token page, causes, governance). |
| `packages/publish` | Swarm upload and ENS contenthash tooling (dry-run by default). |
| `infra/` | AWS CDK app. |

## Contracts

| Contract | Responsibility |
|---|---|
| `VeradaToken` | ERC20 with permit and burn. Fixed supply minted to the factory. Immutable creator and metadata URI. |
| `VeradaFactory` | `deployToken`: deploys the token via CREATE2, initializes the v4 pool (token/WETH, dynamic fee, Verada hook), mints single-sided liquidity through the position manager, sends the position NFT to the locker, and registers the token with the fee vault and governor. |
| `VeradaHook` | Uniswap v4 hook. Sets the dynamic fee (base fee plus a decaying anti-sniper surcharge) and routes collected fees to the fee vault. |
| `VeradaLpLocker` | Holds liquidity position NFTs permanently. Principal can never be withdrawn; only accrued fees are collected and forwarded to the fee vault. |
| `FeeVault` | Splits incoming fees between platform and cause pool; tracks balances per token; releases a token's cause pool for an epoch once a winner exists. |
| `CauseRegistry` | Owner-managed allowlist of causes: `causeId` (hash of the Endaoment organization identifier) to payout address, metadata URI and active flag. |
| `EpochGovernor` | Weekly epochs. Validates votes through a pluggable `IVoteVerifier`, tallies, and records the winning cause on finalization. |
| `DonationDistributor` | After finalization, sends the epoch's cause funds to the winning cause's payout address. |
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

### Weekly epoch governance

- Epochs last 7 days. Epoch 0 starts at a Thursday 00:00 UTC boundary at or after factory deployment.
- During an epoch, token holders vote for an active cause from `CauseRegistry`.
- Vote validity is decided by an `IVoteVerifier` plug-in, so the voting scheme can be replaced
  without changing the governor. A public snapshot verifier exists for tests only.
- After an epoch ends, `finalizeEpoch(token, epoch)` stores the winning `causeId`. The fee vault
  then settles that epoch's cause pool to `DonationDistributor`, which pays the cause.
- `VoteCast` carries an opaque `voteRef` so a private scheme can replace it without event changes.

Key events consumed by the indexer and SDK: `TokenCreated`, `FeesCollected`, `CauseAdded`,
`CauseDeactivated`, `EpochFinalized`, `Donated`, `VoteCast`.

### Deferred work

- **Private voting** is deferred. Only the verifier interface exists today; a production scheme
  (hidden ballots with verifiable tallies) will be a new `IVoteVerifier` implementation.
- **Private donations** are deferred. `IPrivateDonationAdapter` defines the shielded send route, with
  no implementation yet. Donations currently go directly to the cause payout address.

## Endaoment integration

Causes are sourced from Endaoment. `packages/endaoment-client` wraps the organization search API
with typed responses, runtime validation, pagination, retries and an injectable cache. It is used by
the web app for the cause picker and by the indexer service to prepare cause proposals for
`CauseRegistry`. Image URLs in API responses are ignored. Payout addresses written on-chain are
verified by the registry owner before a cause is activated.

## Hosting model

There is no web server. The frontend is a static export published to Ethereum Swarm and reached
through an ENS name whose contenthash points at the Swarm reference. The only always-on service is
the indexer and its Postgres database, on AWS.

```
browser --ENS name--> gateway/resolver --contenthash (EIP-1577, swarm)--> Swarm manifest --> static files
   |
   |--HTTPS JSON + SSE--> indexer (ALB -> ECS Fargate) --> Postgres
   |--JSON-RPC (wagmi/viem)--> Ethereum node   (chain reads fallback, and all wallet writes)
```

### Static frontend

- `apps/web` uses `output: "export"`. Every route is pre-rendered; the token page is a single
  static route that reads the address from the query string, so no route depends on a server.
- All asset references are relative so the same files work under a subdomain gateway and a
  `/bzz/<ref>/` path gateway. No binary assets are shipped; `verify:export` and the publish tool
  both reject them.
- Runtime settings (indexer URLs, RPC URL, chain id, contract addresses) come from `config.json` in
  the bundle, with build-time defaults from `NEXT_PUBLIC_*`. They are public values; no secrets.
  Changing indexer URLs therefore needs a new Swarm reference and a contenthash update.
- Swarm content is immutable per reference. A release is: build, validate, upload, set the new
  contenthash. The previous reference stays addressable while its postage stamp lasts.

### Swarm and ENS contenthash

- `packages/publish` validates the export, estimates stamp depth and cost, uploads through a Bee
  node (only with `--execute`), and encodes the reference as an ENS contenthash.
- Encoding is ENSIP-7 / EIP-1577 for Swarm: `0xe40101fa011b20` followed by the 32-byte reference
  (swarm-ns, CIDv1, swarm-manifest, keccak-256, 32 bytes). The tool prints the exact
  `setContenthash(bytes32,bytes)` calldata; it never signs or sends it. The name's owner submits it.
- Postage stamps (xBZZ on Gnosis Chain) and the ENS transaction are paid by the operator. Content
  expires when its stamp does, so the batch must be topped up.
- The `publish-swarm` workflow only builds, validates and attaches the export as a build artifact.
  It holds no keys, stamp or ENS credentials; upload and the contenthash update are manual.

### Indexer API

The indexer exposes JSON over HTTPS with CORS, cursor pagination and bigint values as decimal
strings: `/health`, `/api/tokens`, `/api/tokens/:address`, `/api/activity` (filterable, newest
first), `/api/activity/stream` (Server-Sent Events with `Last-Event-ID` resume), `/api/causes`,
`/api/causes/search` (cached server-side proxy of Endaoment search, never returning image URLs),
`/api/epochs/:token[/:epoch]` and `/api/stats` (USDC totals, 6 decimals).

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

## AWS topology

Defined in `infra/` with CDK (TypeScript). Only the indexer path lives on AWS; there are no web
hosting resources (no S3 site bucket, CloudFront or web service).

| Stack | Resources |
|---|---|
| `NetworkStack` | VPC across two availability zones with a no-NAT default network and optional private egress. |
| `DataStack` | PostgreSQL for the indexer: RDS (dev default) or Aurora Serverless v2 (prod default), credentials in Secrets Manager. |
| `IndexerStack` | ECR repository, ECS Fargate service behind an Application Load Balancer that must terminate HTTPS, autoscaling, log groups. |
| `ObservabilityStack` | Alarms and a dashboard for the indexer and database. |

Stack ids are `Verada-<env>-<Name>`. Configuration comes from CDK context and Secrets Manager; no
secrets live in code, and IAM is least-privilege. `cdk synth` runs offline in CI with dummy context.

## CI and deployment

- `.github/workflows/ci.yml`: Foundry format, build and test; pnpm install, typecheck and test; a
  static export job (publish tool tests, web tests, export build, export validation, upload dry run
  that sends nothing); an infra job (typecheck, jest, `cdk synth` with dummy context and no AWS
  credentials); and a check that no binary asset files are tracked.
- `.github/workflows/deploy-aws.yml`: manual dispatch. Deploys only the network, data, indexer and
  observability stacks for a chosen environment name. It assumes an AWS role through GitHub OIDC
  (no long-lived keys) and needs the repository variables `AWS_ACCOUNT_ID`, `AWS_REGION` and
  `AWS_DEPLOY_ROLE_NAME`, plus non-secret settings such as the indexer domain or certificate,
  allowed CORS origins and contract addresses.
- `.github/workflows/publish-swarm.yml`: manual dispatch. Builds and validates the static export and
  attaches it (with the dry-run report) as a build artifact. It has read-only repository access, no
  secrets, and never uploads to Swarm or touches ENS.
