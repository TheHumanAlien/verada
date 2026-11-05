# @verada/infra

AWS CDK v2 (TypeScript) app for Verada's only always-on off-chain service: the indexer and its Postgres.

The frontend is a static export published to Ethereum Swarm and resolved through an ENS name's contenthash, so there is no web server, no frontend ECR repository and no CDN in this app. Browsers call the indexer's public HTTPS API directly (and read the chain through their own RPC as a fallback). The AWS CLI session is not required to synth or test; it is required to deploy.

## Stacks

Deploy order (CDK resolves it): `Network` -> `Data` -> `Indexer` -> `Observability`. Stack ids are `Verada-<envName>-<Name>`.

| Stack | Contents |
|---|---|
| Network | VPC with 2 AZs. Default: public and isolated subnets only, no NAT gateway, no interface endpoints, free S3 gateway endpoint, REJECT flow logs. With `privateEgress=true`: adds private subnets, NAT gateway(s) and interface endpoints (ECR api/dkr, CloudWatch Logs, Secrets Manager) |
| Data | `dbMode=rds` (dev default): single-AZ RDS Postgres 16, `db.t4g.micro`, 20 GiB gp3 (autoscale to 100), encrypted, 3-day backups. `dbMode=aurora` (prod default): Aurora Postgres 16 Serverless v2 (0.5 to 2 ACU, 8 in prod, plus a reader in prod). Both sit in isolated subnets, with generated credentials in Secrets Manager (`verada/<env>/db-credentials`). Prod: deletion protection, snapshot on delete, 14-day backups, and Multi-AZ if `dbMode=rds`. Secret rotation (30 days) is enabled only with `privateEgress=true` (see notes) |
| Indexer | ECR repository, ECS cluster, Fargate service (1 vCPU / 2 GiB) behind a public ALB with HTTPS and an HTTP-to-HTTPS redirect, health check `GET /health` on port 42069, circuit breaker. No ALB access logs (they would store client IPs; see docs/PRIVACY.md). Tasks run in public subnets with a public IP (default) whose security group admits only the ALB, or in private subnets with `privateEgress=true` |
| Observability | KMS-encrypted SNS topic (optional email), alarms (unhealthy/no healthy targets, target 5xx, service CPU/memory, DB CPU/connections, plus free storage on RDS) and a dashboard |

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
| `indexerCorsOrigins` | prod | none | Comma-separated bare origins (for example `https://verada.eth.limo,https://verada.bzz.link`), passed as `CORS_ALLOWED_ORIGINS`. `*` allowed in non-prod only |
| `rpcSecretName` | no | `verada/<env>/eth-rpc-url` | Existing Secrets Manager secret holding the Ethereum mainnet RPC URL; injected as `ETH_RPC_URL` |
| `indexerImageTag` | no | `initial` | Image tag in the indexer ECR repository |
| `indexerDesiredCount` / `indexerMaxCount` | no | `1` / same as desired | Task count bounds. The indexer is a single writer per schema, so scale-out is off unless you raise max |
| `startBlock`, `factoryAddress`, `feeVaultAddress`, `causeRegistryAddress`, `epochGovernorAddress`, `donationDistributorAddress` | prod | none | Deployment block and contract addresses, passed as `START_BLOCK`, `FACTORY_ADDRESS`, `FEE_VAULT_ADDRESS`, `CAUSE_REGISTRY_ADDRESS`, `EPOCH_GOVERNOR_ADDRESS`, `DONATION_DISTRIBUTOR_ADDRESS`. Synth fails in prod if any is missing, and in any env if only some are given |
| `alarmEmail` | no | none | Subscribed to the alarm topic (confirm the email) |

Synth fails with a clear message if there is no HTTPS configuration and the environment is prod, or is non-prod without `allowInsecureHttp=true`.

## Offline checks (no AWS credentials)

```sh
pnpm --filter @verada/infra install
cd infra
pnpm test        # jest assertions + cdk-nag AwsSolutions checks (dev, certificate/aurora/privateEgress, prod)
pnpm typecheck
npx cdk synth -c account=111111111111 -c region=us-east-1 -c availabilityZones=us-east-1a,us-east-1b -c allowInsecureHttp=true
```

`111111111111` is a dummy id; nothing is contacted.

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

The container receives env `START_BLOCK`, the five contract addresses, `DATABASE_NAME`, `DATABASE_SCHEMA`, `NODE_ENV`, `PORT`, `CORS_ALLOWED_ORIGINS`, and secrets `ETH_RPC_URL` plus `DATABASE_HOST`/`PORT`/`USER`/`PASSWORD`. The task command builds `DATABASE_URL` (URL-encoded, `sslmode=no-verify`) at start and exits before starting Ponder if any part is empty, so it never falls back to embedded PGlite.

## Notes

- The indexer image must bind `0.0.0.0:42069`, answer `/health` with 200, and provide `sh` and `node`. The browser-facing API needs response streaming for `/api/activity/stream`; the ALB idle timeout (60 s default) closes quiet connections, so the stream should send periodic keep-alive comments and clients resume with `Last-Event-ID`.
- Default network trade-off: tasks have a public IP but no inbound rule except from the ALB; outbound is open (RPC, ECR, Secrets Manager, Endaoment). The database has no route to the internet. Secret rotation needs a VPC Lambda that can reach Secrets Manager, which the default network lacks, so rotation is off by default (justified suppression in `lib/suppressions.ts`).
- cdk-nag AwsSolutions runs at synth; every suppression has a written reason in `lib/suppressions.ts`.
- Not handled here: WAF in front of the ALB, Swarm publishing and ENS contenthash updates (tooling elsewhere).

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

Options that change it: `privateEgress=true` adds NAT (~33 per gateway plus per-GB processing) and 4 interface endpoints across 2 AZs (~58), and removes the task public IP (~-4); `dbMode=aurora` replaces RDS with Aurora Serverless v2 at the 0.5 ACU floor (~44 plus storage and I/O); prod adds a reader, Multi-AZ or larger capacity. Destroying an idle non-prod environment (`npx cdk destroy --all`) removes the cost; non-prod resources are removable.
