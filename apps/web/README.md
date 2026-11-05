# @verada/web

Static-export Next.js app (app router). There is no web server: the `out/` folder is published to
Ethereum Swarm and resolved through an ENS name's contenthash. The only always-on backend is the
indexer; browsers call it over HTTPS and fall back to direct chain reads (wagmi/viem) when it is down.
No styling, no images, icons or fonts; nothing in `out/` may be a binary asset.

## Routes

| Route | Purpose |
|---|---|
| `/` | Token list (`GET /api/tokens`, chain-log fallback) |
| `/launch/` | Form calling `VeradaFactory.deployToken` |
| `/token/?address=0x...` | Single client-side token page; the address is read from the query (or `#0x...` hash) |
| `/causes/` | Nonprofit search via the indexer's `GET /api/causes/search` (names and ids only) |
| `/governance/` | Current epoch (chain read) and vote form behind the vote adapter |
| `/404.html` | Swarm error document (self-contained, no external assets) |

## Static export and Swarm

`next.config.mjs`: `output: "export"`, `trailingSlash: true` (each route is `<route>/index.html`, which a
Swarm manifest serves as a directory index), unoptimized images.

Why no `basePath` / `assetPrefix`: both bake one absolute prefix into the build, so the same output could
not serve under `/bzz/<hash>/`, on a bzz gateway subdomain and at an ENS gateway root. Instead
`scripts/postexport.mjs` (run by `build`) makes the output hash-agnostic:

- HTML `/_next/...` references become depth-relative (`./_next/` at the root, `../_next/` one level down).
- The webpack runtime public path is derived from the runtime script's own URL, so lazy chunks load from
  wherever the bundle is served.
- `404.html` is replaced by a self-contained page, because the error document is served at any depth.
- Navigation uses plain relative anchors (`components/nav.tsx`), not `next/link`, which would push absolute
  paths. Runtime URLs (`config.json`) resolve against `siteBase()` in `src/lib/base.ts`.

Publishing (done outside this repo, never by CI here): upload `out/` as a Swarm collection with
index document `index.html` and error document `404.html`. For the ENS name, the contenthash is an EIP-1577
value: `0xe4` (swarm-ns) + `01` (CIDv1) + `fa01` (swarm-manifest) + `1b` (keccak-256) + `20` (32 bytes) +
the 32-byte Swarm reference, i.e. `0xe40101fa011b20<reference>` (text form `bzz://<reference>`).

## Runtime configuration

At startup the app fetches `config.json` (next to the page, so it follows the bundle) and merges it over
build-time defaults from `NEXT_PUBLIC_*` (see `.env.example`). Public values only, no secrets.

```json
{
  "chainId": 1,
  "indexerUrls": ["https://indexer-a.example", "https://indexer-b.example"],
  "rpcUrl": "https://...", "factoryAddress": "0x...", "factoryDeployBlock": 0,
  "vaultAddress": "0x...", "governorAddress": "0x..."
}
```

An invalid or missing file falls back to the defaults. `public/config.json` ships a local-development default.

## Data layer

- `src/lib/indexer.ts`: client for the indexer contract (`/health`, `/api/tokens`, `/api/activity`,
  `/api/causes[/search]`, `/api/epochs/...`, `/api/stats`), cursor pagination, ordered failover across
  `indexerUrls` (network errors and 5xx fail over, 4xx does not), bigint values kept as decimal strings.
- `src/lib/activity-stream.ts`: Server-Sent Events subscription with Last-Event-ID resume (browser
  default), dropping to polling `/api/activity` after repeated SSE errors or without `EventSource`.
- `src/lib/chain-reads.ts` / `src/lib/data.ts`: core reads (token list/detail from `TokenCreated` logs,
  current epoch, cause pool) straight from the chain when the indexer is down. Set `factoryDeployBlock` to
  bound the log scan; the RPC must allow that range.

## Voting adapter

`src/lib/vote-adapter.ts` defines `VoteAdapter`; the shipped adapter is a marked placeholder with no
privacy. A private scheme plugs in by implementing `VoteAdapter` and registering it in `voteAdapters`.

## Scripts

`pnpm --filter @verada/web typecheck | lint | test | build | verify:export | build:verify`

`verify:export` (or `node scripts/verify-export.mjs --build`) checks `out/`: no binary extensions or
content, `index.html` for every route, `404.html` and `config.json` present, no root-absolute `/_next/`
references left, runtime public path patched.
