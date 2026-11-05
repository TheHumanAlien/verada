# @verada/publish

Tooling to publish the static web export to Ethereum Swarm and point an ENS name's contenthash at it. There is no web server: the frontend is static files on Swarm, resolved through ENS; only the indexer stays on AWS.

Everything here is dry-run or read-only by default. The tool never signs, never sends a transaction, and never reads or logs a private key.

## Commands

Run from the repo root: `node packages/publish/bin/verada-publish.mjs <command>` (or `pnpm --filter @verada/publish cli <command>`).

| Command | What it does |
| --- | --- |
| `build` | Runs the web static export (`--cmd`, default `pnpm --filter @verada/web build`) then validates the output directory (`--dir`, default `apps/web/out`). |
| `validate` | Validates an existing export: no binary files (by extension and NUL-byte sniff), no root-absolute `href`/`src`/`url()` paths, `index.html` at the root and in every directory that has html, size report. |
| `upload` | Validates, prints size, stamp depth and cost estimate. Uploads only with `--execute`. |
| `feed-update` | Appends a release reference to the site feed (`--execute`) and prints the stable feed manifest reference, its contenthash and, with `--registry`, the `setDefaultContenthash(bytes)` calldata for the Verada profile registry. Needs `SITE_FEED_PRIVATE_KEY` (signs Swarm feed updates only). |
| `feed-read` | Reads the latest reference of a feed by owner and topic. Read-only. |
| `ens-contenthash` | Swarm reference to EIP-1577 contenthash and exact calldata: `setDefaultContenthash(bytes)` for the Verada registry (`--registry`), or `setContenthash(bytes32,bytes)` for a standard resolver. Not signed or sent. |
| `verify` | Reads the name's contenthash over RPC and checks it equals a reference. Optional `--gateway` checks the content is reachable. |

## Runbook

1. Build and validate: `verada-publish build`. Fix every reported error. The export must use relative paths so it works under both `bzz.link`-style subdomain gateways and `/bzz/<ref>/` path gateways.
2. Dry run: `verada-publish upload --ttl-days 90`. Note the stamp depth and cost. The price per chunk per block is an assumption (`--price-per-block`, default 24000 PLUR); check the current value on your node (`/chainstate`) before buying.
3. Buy a postage batch on your own Bee node at (at least) that depth and amount, and wait until it is usable. Export `BEE_URL` (default `http://localhost:1633`) and `BEE_POSTAGE_BATCH_ID`. The batch id is an identifier, not a key.
4. Upload: `verada-publish upload --execute --pin --index-document index.html --error-document 404.html`. It prints the Swarm reference. Use `--pin` so your node keeps the content.
5. Open `bzz://<ref>` on a gateway or your node and check the site loads, including a deep link and the 404 page.
6. Contenthash: `verada-publish ens-contenthash --ref <ref> --name yourname.eth --rpc $ETH_RPC_URL`. This looks up the resolver read-only in the ENS registry (`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`) and prints the resolver address and calldata. Without an RPC, pass `--resolver <addr>`.
7. Submit that calldata to the resolver yourself, from the wallet that controls the name (or use the ENS manager app and paste the `bzz://<ref>` / contenthash). The tool does not send it.
8. Verify: `verada-publish verify --name yourname.eth --ref <ref> --rpc $ETH_RPC_URL [--gateway https://...]`.

Re-publish: repeat steps 1-8; each build has a new reference, and only the contenthash needs updating. Keep the postage batch topped up (or buy a new one) before it expires, or the content will be dropped by the network.

## Stable contenthash with a Swarm feed (how Verada publishes)

Verada serves one site for `varada.eth` and every `<label>.varada.eth` through its own resolver, which returns the default contenthash stored in `TokenProfileRegistry`. To avoid an on-chain transaction per release, that contenthash points at a **feed manifest** instead of a release reference:

1. Upload the export as in the runbook (step 4) and note the release reference.
2. `SITE_FEED_PRIVATE_KEY=0x... BEE_POSTAGE_BATCH_ID=... verada-publish feed-update --ref <release ref> --execute --registry <TokenProfileRegistry>`. The key only signs single-owner chunks on Swarm (no funds); keep it in a secret store, never in the repo. The batch must be immutable. The command prints the feed owner, the feed manifest reference (stable for this key and topic) and the registry calldata.
3. The first time only, the registry owner submits `setDefaultContenthash(bytes)` with the printed contenthash. Later releases are just another `feed-update`; gateways resolve the manifest to the newest reference (eth.limo caches for about five minutes).
4. `verada-publish feed-read --owner <feed owner>` shows what the feed currently points at; `verify --name varada.eth --ref <feed manifest>` checks the on-chain contenthash.

ENS lookups go through the ENSv2 Universal Resolver (`0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`), which also finds names still on the v1 registry.

## Encoding

ENSIP-7 / EIP-1577 Swarm contenthash: `e4 01` (swarm-ns, varint) `01` (CIDv1) `fa 01` (swarm-manifest) `1b` (keccak-256) `20` (32 bytes) then the 32-byte reference, i.e. `0xe40101fa011b20<ref>`. Unit tests pin this against the ENSIP-7 example vector and cross-check `@ensdomains/content-hash`. Encrypted (128 hex) references cannot be used.

## Costs, paid by you

- Postage stamps cost xBZZ (Gnosis Chain), set by depth (capacity) and amount (lifetime). The dry-run figures are estimates only; real cost depends on the live price and your node's batch.
- Setting the contenthash is an Ethereum transaction. The gas, and ENS name registration or renewal, are paid by the account that submits it. Nothing in this package pays for or sends anything.

## Tests

`pnpm --filter @verada/publish test` uses fixed vectors and temp directories only; no network access.
