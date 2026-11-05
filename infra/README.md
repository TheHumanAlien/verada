# @verada/infra

AWS CDK v2 (TypeScript) app for Verada's always-on off-chain services: the indexer and its Postgres, a Bee light node with the Swarm gateway, and the feed publisher.

The frontend is a static export published to Ethereum Swarm and resolved through an ENS name's contenthash, so there is no web server, no frontend ECR repository and no CDN in this app. Browsers call the indexer's public HTTPS API directly (and read the chain through their own RPC as a fallback). The publisher uploads site content and feed updates to Swarm through Verada's own gateway. The AWS CLI session is not required to synth or test; it is required to deploy.

## Stacks

Deploy order (CDK resolves it): `Network` -> `Data` -> `Indexer`, `Network` -> `Swarm` -> `Publisher`, then `Observability`. Stack ids are `Verada-<envName>-<Name>`. The publisher finds the gateway by URL from context (`https://<swarmDomainName>`), not by a cross-stack reference; the Swarm-before-Publisher order is an explicit deploy dependency only.

| Stack | Contents |
|---|---|
| Network | VPC with 2 AZs. Default: public and isolated subnets only, no NAT gateway, no interface endpoints, free S3 gateway endpoint, REJECT flow logs. With `privateEgress=true`: adds private subnets, NAT gateway(s) and interface endpoints (ECR api/dkr, CloudWatch Logs, Secrets Manager) |
| Data | `dbMode=rds` (dev default): single-AZ RDS Postgres 16, `db.t4g.micro`, 20 GiB gp3 (autoscale to 100), encrypted, 3-day backups. `dbMode=aurora` (prod default): Aurora Postgres 16 Serverless v2 (0.5 to 2 ACU, 8 in prod, plus a reader in prod). Both sit in isolated subnets, with generated credentials in Secrets Manager (`verada/<env>/db-credentials`). Prod: deletion protection, snapshot on delete, 14-day backups, and Multi-AZ if `dbMode=rds`. Secret rotation (30 days) is enabled only with `privateEgress=true` (see notes) |
| Indexer | ECR repository, ECS cluster, Fargate service (1 vCPU / 2 GiB) behind a public ALB with HTTPS and an HTTP-to-HTTPS redirect, health check `GET /health` on port 42069, circuit breaker. No ALB access logs (they would store client IPs; see docs/PRIVACY.md). Tasks run in public subnets with a public IP (default) whose security group admits only the ALB, or in private subnets with `privateEgress=true` |
| Swarm | One Fargate task (1 vCPU / 2 GiB, `desiredCount` 1, no autoscaling) with two containers. `bee` (`ethersphere/bee:2.8.3`, `start`): light node (`BEE_FULL_NODE=false`), SWAP on, mainnet, API bound to `127.0.0.1:1633` inside the task only, data directory `/home/bee/.bee` on EFS. `gateway` (`ethersphere/swarm-gateway:0.4.0`, port 3000): talks to Bee over the task loopback, `SOFT_AUTH=true` (reads open, every POST needs `AUTH_SECRET` in `Authorization`), autobuys/tops up a postage batch from the node wallet, `POST_SIZE_LIMIT=4mb`. Only the gateway sits behind the public ALB (HTTPS, HTTP-to-HTTPS redirect, health `GET /health`). EFS: encrypted, TLS + IAM mounts through an access point owned by uid/gid 999 (the Bee image user), elastic throughput, AWS Backup daily plan, `RETAIN` in prod and `DESTROY` elsewhere. Deployments stop the old task before starting the new one because the Bee data directory is single-writer |
| Publisher | ECR repository and a Fargate service (0.5 vCPU / 1 GiB, `desiredCount` 1) for `services/publisher` on port 42070, health `GET /health`, behind a public ALB with HTTPS and an HTTP-to-HTTPS redirect. Secrets from `verada/<env>/publisher` |
| Observability | KMS-encrypted SNS topic (optional email), alarms (unhealthy/no healthy targets, target 5xx, service CPU/memory, DB CPU/connections, plus free storage on RDS; for Swarm and Publisher: unhealthy targets, no running task, target 5xx, memory) and a dashboard |

## Context values

No account ids, regions or secrets are in code. Pass with `-c key=value` or put them in `cdk.context.json` (git-ignored).

| Key | Required | Default | Meaning |
|---|---|---|---|
| `account`, `region` | yes (or `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`) | none | 12-digit account id, region |
| `envName` | no | `dev` | `[a-z][a-z0-9-]{1,14}`; `prod` changes defaults and enforces HTTPS and CORS |
| `availabilityZones` | no | looked up | Comma-separated zones; seeds the AZ lookup so synth works offline |
| `dbMode` | no | `rds` (`aurora` for prod) | `rds` or `aurora` |
| `privateEgress` | no | `false` | `true` restores NAT + interface endpoints and private task subnets; also enables secret rotation |
| `natGateways` | no | `1` | NAT count, used only with `privateEgress` |
| `indexerDomainName` | yes (HTTPS) | none | Hostname browsers call, e.g. `indexer.example.org` |
| `indexerCertificateArn` | one of two | none | Existing ACM certificate in the stack's region covering `indexerDomainName`. Create the DNS record yourself (CNAME/alias to the `LoadBalancerDnsName` output) |
| `indexerHostedZoneId` + `indexerHostedZoneName` | one of two | none | Route53 zone containing the domain: the stack creates a DNS-validated certificate and the alias record. The zone must be in this account |
| `allowInsecureHttp` | no | `false` | Non-prod only: serve plain HTTP when no HTTPS settings are given. Rejected in prod and when combined with HTTPS settings |
| `indexerCloudFront` | no | `false` | With `allowInsecureHttp=true` and no indexer domain: put CloudFront in front of the indexer ALB so browsers get HTTPS on the default `*.cloudfront.net` domain (output `IndexerUrl`). The ALB returns 403 to anything without CloudFront's origin header |
| `indexerCloudFrontPrefixListId` | no | – | CloudFront origin-facing managed prefix list for the region (`aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing`; `pl-fab65393` in eu-north-1). When set, only CloudFront can reach the ALB |
| `indexerCorsOrigins` | prod | none | Comma-separated bare origins (for example `https://verada.eth.limo,https://verada.bzz.link`), passed as `CORS_ALLOWED_ORIGINS`. `*` allowed in non-prod only |
| `rpcSecretName` | no | `verada/<env>/eth-rpc-url` | Existing Secrets Manager secret holding the Ethereum mainnet RPC URL; injected as `ETH_RPC_URL` |
| `indexerImageTag` | no | `initial` | Image tag in the indexer ECR repository |
| `indexerDesiredCount` / `indexerMaxCount` | no | `1` / same as desired | Task count bounds. The indexer is a single writer per schema, so scale-out is off unless you raise max |
| `startBlock`, `factoryAddress`, `feeVaultAddress`, `causeRegistryAddress`, `epochGovernorAddress`, `donationDistributorAddress` | prod | none | Deployment block and contract addresses, passed as `START_BLOCK`, `FACTORY_ADDRESS`, `FEE_VAULT_ADDRESS`, `CAUSE_REGISTRY_ADDRESS`, `EPOCH_GOVERNOR_ADDRESS`, `DONATION_DISTRIBUTOR_ADDRESS`. Synth fails in prod if any is missing, and in any env if only some are given |
| `feeConsolidatorAddress`, `quoteRegistryAddress` | prod | none | Passed as `FEE_CONSOLIDATOR_ADDRESS`, `QUOTE_REGISTRY_ADDRESS` (the indexer requires both). Missing outside prod is a synth warning, not an error |
| `tokenRegistryAddress`, `takeoverGovernorAddress`, `votingSchemeAddress` | no | zero address | Passed as `TOKEN_REGISTRY_ADDRESS`, `TAKEOVER_GOVERNOR_ADDRESS`, `VOTING_SCHEME_ADDRESS` |
| `alarmEmail` | no | none | Subscribed to the alarm topic (confirm the email) |
| `swarmDomainName` | yes (HTTPS) | none | Gateway hostname, e.g. `swarm.example.org`; also the gateway's `HOSTNAME` (subdomain routing base) |
| `swarmCertificateArn` | one of two | none | ACM certificate for `swarmDomainName` (point DNS at the Swarm `LoadBalancerDnsName` output yourself) |
| `swarmHostedZoneId` + `swarmHostedZoneName` | one of two | none | Route53 zone: the stack issues the certificate and creates the alias record |
| `beeSecretName` | no | `verada/<env>/bee` | JSON secret, fields below |
| `beeImage` / `swarmGatewayImage` | no | `ethersphere/bee:2.8.3` / `ethersphere/swarm-gateway:0.4.0` | Image references (Docker Hub) |
| `beeUid` / `beeGid` | no | `999` / `999` | Owner of the EFS access point; must match the user the Bee image runs as |
| `swarmDesiredCount` | no | `1` | `0` parks the node (the `NoRunningTasks` alarm then fires); values above 1 are rejected |
| `swarmPostageDepth` / `swarmPostageAmount` / `swarmPostageKeepAlive` | no | `22` / `1270000000000` / `true` | Gateway autobuy batch (`POSTAGE_DEPTH`, `POSTAGE_AMOUNT` in PLUR per chunk, `POSTAGE_KEEP_ALIVE`) |
| `publisherDomainName` | yes (HTTPS) | none | Publisher API hostname |
| `publisherCertificateArn` | one of two | none | ACM certificate for `publisherDomainName` |
| `publisherHostedZoneId` + `publisherHostedZoneName` | one of two | none | Route53 zone: certificate and alias record created by the stack |
| `publisherSecretName` | no | `verada/<env>/publisher` | JSON secret, fields below |
| `publisherImageTag` | no | `initial` | Image tag in the publisher ECR repository |
| `publisherDesiredCount` | no | `1` | `0` for the first deploy (empty repository); values above 1 are rejected (one keeper signer) |
| `swarmGatewayUrl` | no | `https://<swarmDomainName>` | Override for `BEE_GATEWAY_URL` and `PUBLIC_GATEWAY_URL` (needed when the gateway has no domain, e.g. a throwaway HTTP env) |
| `indexerPublicUrl` | no | `https://<indexerDomainName>` | `INDEXER_URL` |
| `arkivChain` | no | `rabdi` | `ARKIV_CHAIN` |
| `arkivEnabled` | no | `false` | `ARKIV_ENABLED` |
| `publisherCorsOrigins` | no | value of `indexerCorsOrigins` | `CORS_ALLOWED_ORIGINS` for the publisher; same bare-origin rules |
| `publisherJobIntervalSeconds` | no | `60` | `JOB_INTERVAL_SECONDS` (minimum 5) |

Synth fails with a clear message if a public service (indexer, Swarm gateway, publisher) has no HTTPS configuration and the environment is prod, or is non-prod without `allowInsecureHttp=true`. For the indexer the flag must not be combined with its HTTPS settings; the gateway and publisher fall back to HTTP only where they have no HTTPS settings, so a dev environment can move them to HTTPS one at a time.

## Secrets

Create these before deploying; the stacks import them by name and never create or read their values.

| Secret | Format | Fields -> task variables |
|---|---|---|
| `verada/<env>/eth-rpc-url` | plain string | Ethereum mainnet RPC URL, or several comma-separated (the indexer load-balances across them) -> indexer `ETH_RPC_URL` |
| `verada/<env>/bee` | JSON | `password` -> `BEE_PASSWORD` (encrypts the Bee key file on EFS); `gnosisRpcUrl` -> `BEE_BLOCKCHAIN_RPC_ENDPOINT` (Gnosis Chain RPC); `gatewayAuthSecret` -> gateway `AUTH_SECRET` |
| `verada/<env>/publisher` | JSON | `beeGatewayAuthSecret` -> `BEE_GATEWAY_AUTH_SECRET` (must equal the bee secret's `gatewayAuthSecret`; sent verbatim as the `Authorization` header); `swarmBatchId` -> `SWARM_BATCH_ID`; `arkivAccessKey` -> `ARKIV_ACCESS_KEY`; `arkivPrivateKey` -> `ARKIV_PRIVATE_KEY`; `keeperPrivateKey` -> `KEEPER_PRIVATE_KEY`; `ethRpcUrl` -> `ETH_RPC_URL` |

```sh
aws secretsmanager create-secret --name verada/<env>/bee \
  --secret-string '{"password":"<long random>","gnosisRpcUrl":"https://<gnosis-rpc>","gatewayAuthSecret":"<long random>"}'
aws secretsmanager create-secret --name verada/<env>/publisher \
  --secret-string '{"beeGatewayAuthSecret":"<same as gatewayAuthSecret>","swarmBatchId":"<batch id>","arkivAccessKey":"...","arkivPrivateKey":"0x...","keeperPrivateKey":"0x...","ethRpcUrl":"https://<mainnet-rpc>"}'
```

Every field must exist: ECS fails to start a task when a referenced JSON key is missing. With Arkiv disabled, still create the two Arkiv fields (any placeholder value).

## Offline checks (no AWS credentials)

```sh
pnpm --filter @verada/infra install
cd infra
pnpm test        # jest assertions + cdk-nag AwsSolutions checks (dev, certificate/aurora/privateEgress, prod)
pnpm typecheck
npx cdk synth -c account=111111111111 -c region=us-east-1 -c availabilityZones=us-east-1a,us-east-1b -c allowInsecureHttp=true
```

`111111111111` is a dummy id; nothing is contacted. Without the indexer chain keys the synth warns that the indexer tasks would exit at start-up, and without `swarmDomainName`/`indexerDomainName` it warns that the publisher has no gateway or indexer URL; the Swarm and Publisher stacks still synthesize (HTTP-only) under `allowInsecureHttp=true`.

## Deploy

Prerequisite: a valid AWS session for the target account. Nothing here logs in for you.

1. Bootstrap once per account/region: `npx cdk bootstrap aws://<account>/<region>`
2. Create the RPC secret: `aws secretsmanager create-secret --name verada/<env>/eth-rpc-url --secret-string '<rpc-url>'`
3. Choose HTTPS: either request/import an ACM certificate (pass `indexerCertificateArn`) or pass the hosted zone pair.
4. Review: `npx cdk diff -c account=<account> -c region=<region> -c envName=<env> -c indexerDomainName=<host> -c indexerCertificateArn=<arn> -c indexerCorsOrigins=<origins>`
5. First deploy with the indexer at zero (the ECR repository is empty): same flags plus `-c indexerDesiredCount=0`, stacks `Verada-<env>-Network Verada-<env>-Data Verada-<env>-Indexer`.
6. Build and push the indexer image (Dockerfile owned by `services/indexer`, built from the repository root, `linux/amd64`):
   ```sh
   REPO=$(aws cloudformation describe-stacks --stack-name Verada-<env>-Indexer --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" --output text)
   aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
   docker build --platform linux/amd64 -f services/indexer/Dockerfile -t "$REPO:<tag>" .
   docker push "$REPO:<tag>"
   ```
7. Deploy all with the real tag and the chain values: `npx cdk deploy --all ... -c indexerImageTag=<tag> -c startBlock=... -c factoryAddress=...`
8. With a certificate ARN and no hosted zone, point `indexerDomainName` at the `LoadBalancerDnsName` output. The `IndexerUrl` output is what the static frontend is built against.
9. Swarm and publisher: create the two JSON secrets above, pass the `swarm*` and `publisher*` HTTPS keys, and deploy `Verada-<env>-Swarm` first. Then deploy `Verada-<env>-Publisher` with `-c publisherDesiredCount=0`, push the publisher image the same way as step 6 (`services/publisher/Dockerfile`, repository from the Publisher stack's `RepositoryUri` output), and redeploy with `-c publisherImageTag=<tag>`.

## Swarm operator checklist

1. **Fund the Bee wallet.** On first start Bee creates its key on EFS and logs its Ethereum address (CloudWatch log group of the Swarm stack, stream prefix `bee`). Send it xDAI (gas, and the SWAP chequebook deployment) and xBZZ on Gnosis Chain. Until it is funded Bee waits and its health check may fail, so ECS can restart the task a few times; the key is on EFS, so the address does not change. The gateway autobuys (and, with keep-alive, tops up) its postage batch from this wallet, so keep xBZZ on it; the batch costs `2^depth x amount` PLUR (depth 22, amount 1270000000000 by default).
2. **Back up the node key.** The Bee key, chequebook state and local store live on the EFS file system (`BeeFileSystemId` output, access point path `/bee`). AWS Backup takes daily backups and the file system is retained in prod, but also export `keys/` from the volume (encrypted with the `password` field) and store it with the bee secret: losing it loses the wallet and every batch it owns.
3. **TLS for the ENS name.** Request a wildcard certificate from eth.limo for `*.verada.eth.limo` so token subnames resolve over HTTPS.
4. **Default contenthash.** After the first feed publish, call `TokenProfileRegistry.setDefaultContenthash` with the feed's contenthash so tokens without their own site resolve to it.
5. Never run a second task against the same file system: two Bee processes on one data directory corrupt it. Keep `swarmDesiredCount` at 0 or 1.

Images come from Docker Hub (anonymous pulls, rate limited per IP; a single task is far below the limit). Bee's P2P port is not opened inbound: a light node only dials out.

The container receives env `START_BLOCK`, the five contract addresses, `DATABASE_NAME`, `DATABASE_SCHEMA`, `NODE_ENV`, `PORT`, `CORS_ALLOWED_ORIGINS`, and secrets `ETH_RPC_URL` plus `DATABASE_HOST`/`PORT`/`USER`/`PASSWORD`. The task command builds `DATABASE_URL` (URL-encoded, `sslmode=no-verify`) at start and exits before starting Ponder if any part is empty, so it never falls back to embedded PGlite.

## Notes

- The indexer image must bind `0.0.0.0:42069`, answer `/health` with 200, and provide `sh` and `node`. The browser-facing API needs response streaming for `/api/activity/stream`; the ALB idle timeout (60 s default) closes quiet connections, so the stream should send periodic keep-alive comments and clients resume with `Last-Event-ID`.
- Default network trade-off: tasks have a public IP but no inbound rule except from the ALB; outbound is open (RPC, ECR, Secrets Manager, Endaoment). The database has no route to the internet. Secret rotation needs a VPC Lambda that can reach Secrets Manager, which the default network lacks, so rotation is off by default (justified suppression in `lib/suppressions.ts`).
- cdk-nag AwsSolutions runs at synth; every suppression has a written reason in `lib/suppressions.ts`.
- The Bee image is debian-slim with no wget or curl, so its container health check uses bash's `/dev/tcp` to send `GET /health` to `127.0.0.1:1633` and requires a `200` status line. The gateway image is node-slim, so its check uses `node -e fetch(...)`. The gateway starts only after Bee is healthy.
- Not handled here: WAF in front of the ALBs, ENS contenthash updates (tooling elsewhere).

## Cost note

These figures are rough estimates from memory of us-east-1 on-demand list prices (730 h/month), not verified: the AWS Pricing tool was unavailable when this was written (client error). Verify with the AWS Pricing Calculator or the Price List API before budgeting. Excludes data transfer and request volume beyond the minimums.

Indexer-only `dev` defaults (rds, no NAT, no endpoints), approximate USD per month:

| Line item | Estimate |
|---|---|
| ALB hourly | ~16 |
| ALB LCUs (minimum, light traffic) | ~6 |
| Public IPv4: 2 ALB addresses + 1 task | ~11 |
| Fargate 1 vCPU / 2 GiB x86, one task | ~36 |
| RDS `db.t4g.micro` single-AZ | ~12 |
| RDS 20 GiB gp3 | ~2-3 |
| Secrets Manager (DB secret; RPC secret) | ~1 |
| CloudWatch alarms, dashboard, logs, flow logs | ~5-10 |
| KMS key (alarm topic) | ~1 |
| Total | roughly 90-100 |

The Swarm and Publisher stacks add, roughly: two more ALBs (~22 each plus ~7 for their public IPv4 addresses), Fargate 1 vCPU / 2 GiB (~36) and 0.5 vCPU / 1 GiB (~18), EFS storage and elastic throughput for a light node (a few dollars) plus AWS Backup, and two more Secrets Manager secrets (~1). Same caveat: unverified estimates.

Options that change it: `privateEgress=true` adds NAT (~33 per gateway plus per-GB processing) and 4 interface endpoints across 2 AZs (~58), and removes the task public IP (~-4); `dbMode=aurora` replaces RDS with Aurora Serverless v2 at the 0.5 ACU floor (~44 plus storage and I/O); prod adds a reader, Multi-AZ or larger capacity. Destroying an idle non-prod environment (`npx cdk destroy --all`) removes the cost; non-prod resources are removable.
