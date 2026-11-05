# @verada/web

Static-export Next.js app (app router). There is no web server: the `out/` folder is published to
Ethereum Swarm and resolved through an ENS name's contenthash. The only always-on backend is the
indexer; browsers call it over HTTPS and fall back to direct chain reads (wagmi/viem) when it is down.
No styling, no images, icons or fonts; nothing in `out/` may be a binary asset.

## Routes

| Route | Purpose |
|---|---|
| `/` | Token list (`GET /api/tokens`, chain-log fallback), or a token's page when served on its ENS name (see Hostname routing) |
| `/launch/` | Launch form: logo and metadata uploads, ENS label, `VeradaFactory.deployToken` |
| `/token/?address=0x...` | Single client-side token page; the address is read from the query (or `#0x...` hash), or resolved from `?label=` |
| `/causes/` | Nonprofit search via the indexer's `GET /api/causes/search` (names and ids only) |
| `/governance/` | Current epoch (chain read); ballots are cast from each token's page |
| `/404.html` | Swarm error document (self-contained, no external assets); `/<label>` redirects to `token/?label=<label>` |

## Static export and Swarm

`next.config.mjs`: `output: "export"`, `trailingSlash: true` (each route is `<route>/index.html`, which a
Swarm manifest serves as a directory index), unoptimized images.

Why no `basePath` / `assetPrefix`: both bake one absolute prefix into the build, so the same output could
not serve under `/bzz/<hash>/`, on a bzz gateway subdomain and at an ENS gateway root. Instead
`scripts/postexport.mjs` (run by `build`) makes the output hash-agnostic:

- HTML `/_next/...` references become depth-relative (`./_next/` at the root, `../_next/` one level down).
- The webpack runtime public path is derived from the runtime script's own URL, so lazy chunks load from
  wherever the bundle is served.
- `404.html` is replaced by a self-contained page, because the error document is served at any depth. Its
  inline script (`labelRedirect` in `scripts/postexport.mjs`) sends a one-segment path that passes the label
  rules (`/pepe`, `/bzz/<64-hex>/pepe`, lowercased) to `./token/?label=pepe` (`../` with a trailing
  slash), a relative URL that works on subdomain and path gateways alike. Route names and anything else
  show the 404 content.
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
  "vaultAddress": "0x...", "governorAddress": "0x...",
  "publisherUrl": "https://publisher.example", "swarmGatewayUrl": "https://gw.example",
  "ensParentName": "varada.eth", "profileRegistryAddress": "0x...",
  "votingSchemeAddress": "0x...", "takeoverGovernorAddress": "0x...",
  "zamaRelayerUrl": "https://..."
}
```

| Key | `NEXT_PUBLIC_*` | Purpose |
|---|---|---|
| `publisherUrl` | `PUBLISHER_URL` | Publisher base URL for `POST /uploads/logo` and `/uploads/metadata` |
| `swarmGatewayUrl` | `SWARM_GATEWAY_URL` | Public Swarm read gateway; logos load from `<base>/bzz/<logoRef>/` |
| `ensParentName` | `ENS_PARENT_NAME` | Parent name (default `varada.eth`): `<label>.<parent>` names and hostname routing |
| `profileRegistryAddress` | `PROFILE_REGISTRY_ADDRESS` | `TokenProfileRegistry`: label availability, profile fallback reads, profile edits |
| `votingSchemeAddress` | `VOTING_SCHEME_ADDRESS` | `ZamaVotingScheme`: ballots are sent here (an opened poll's own scheme wins) |
| `takeoverGovernorAddress` | `TAKEOVER_GOVERNOR_ADDRESS` | `TakeoverGovernor`: the takeover panel |
| `zamaRelayerUrl` | `ZAMA_RELAYER_URL` | Optional relayer override; otherwise the SDK's preset for the chain |
| (build time only) | `DEV_PLAIN_BALLOTS` | `true` sends plaintext ballots to the mock scheme. Development only; `config.json` cannot set it |

All values are zod-validated; an invalid or missing file falls back to the defaults. `public/config.json`
ships a local-development default (indexer on 42069, publisher on 42070).

## Data layer

- `src/lib/indexer.ts`: client for the indexer contract (`/health`, `/api/tokens`, `/api/activity`,
  `/api/causes[/search]`, `/api/epochs/...`, `/api/stats`), cursor pagination, ordered failover across
  `indexerUrls` (network errors and 5xx fail over, 4xx does not), bigint values kept as decimal strings.
- `src/lib/activity-stream.ts`: Server-Sent Events subscription with Last-Event-ID resume (browser
  default), dropping to polling `/api/activity` after repeated SSE errors or without `EventSource`.
- `src/lib/chain-reads.ts` / `src/lib/data.ts`: core reads (token list/detail from `TokenCreated` logs,
  current epoch, cause pool) straight from the chain when the indexer is down. Set `factoryDeployBlock` to
  bound the log scan; the RPC must allow that range.

## Launch flow

1. Logo: the file input posts the image to `{publisherUrl}/uploads/logo` (multipart field `file`,
   PNG/JPEG/WebP, 2 MiB at most; the form prechecks size and type). The preview is a local object URL.
   The returned reference becomes the on-chain `logoRef` (`swarmReferenceToBytes32`).
2. Label: prefilled from `labelFromSymbol(symbol)` until edited, validated with `isValidLabel`, and
   checked against `TokenProfileRegistry.tokenByLabelhash` / `reservationOf` through the public-scope
   private RPC. The form shows the resulting `<label>.<parent>` name.
3. Metadata: on submit, `{ name, symbol, logoRef, description?, website?, twitter?, telegram?, discord? }`
   is posted to `{publisherUrl}/uploads/metadata` and the returned `bzz://` URI becomes `metadataURI`
   (an "override" field in Advanced skips the upload). The document never includes a wallet address,
   and upload requests send no cookies or referrer.
4. Quote asset: WETH by default; other options come from the indexer's `GET /quote-assets?active=true`
   (a static Ondo suggestion list when the route is missing). The factory rejects anything not allowlisted.
5. `deployToken` is sent from the wallet. After the receipt, the `TokenCreated` log gives the address
   and the form links to the token page and to `https://<label>.<parent>.limo/`.

`parseLaunchInput` and `buildMetadataDocument` (`src/lib/launch.ts`) are pure and unit-tested.

## Token page

`components/token-detail.tsx` composes:

- `token-profile-view.tsx`: name/symbol, logo `<img>` from the Swarm gateway, ENS name and eth.limo
  link, text records (`url`, `description`, `com.twitter`, `org.telegram`, `com.discord`, `com.github`)
  from the indexer profile, read through ENS (`getTokenTextRecord`) when the indexer has none,
  controller and editor.
- `epoch-panel.tsx`: current epoch, options with cause names from `/api/causes` and the catalogue
  (`/api/catalog/causes`), a "ballot not prepared yet" state (only the pins are known until the
  rotation draws are made), poll state, per-option totals once the tally is decrypted, the connected
  account's weight and `hasVoted` (account-scoped client, never the indexer), and the vote form.
- `edit-profile-panel.tsx` (controller or editor): `setText` per key, `setLogoRef` via a new upload,
  `setContenthash` (`bzz://<ref>` or raw hex; empty restores the default) and, for the controller, `setEditor`.
- `shortlist-editor.tsx` ("Pinned causes", controller): up to 8 catalogue orgs inside the token's
  focus, picked with the catalogue browser; each is saved with its in-focus entry and Merkle proof
  through `EpochGovernor.setShortlist`. Changes take effect from the next epoch once the current
  ballot is prepared.
- `catalog-browser.tsx`: browses the cause catalogue by name, category and region (Causes page, pin
  editor) and the launch form's focus picker, which shows the focus pool size (a launch needs two).
- `token-detail.tsx` shows the token's cause focus.
- `takeover-panel.tsx`: active proposal state (including `Superseded`), parameters with the holding
  period (`lookback`: weight is the smaller of the votes at the snapshot and `lookback` earlier), quorum
  as a share of the proposal's `circulatingWeight`, FOR/AGAINST ballots, `closeProposal` / `recordTally` /
  `execute` / `cancel` when applicable, a propose form, and history from `/api/takeovers/:token`
  (chain fallback: the active proposal only).

The indexer is read first for everything; when it is down the page falls back to registry, governor and
scheme reads through the public-scope private RPC.

## Voting

Ballots go to the voting scheme, sent by the voter: `castBallot(governor, token, scope, ballot)`, where
`scope` is the epoch (epoch governor) or the proposal id (takeover governor).

- `src/lib/ballot.ts` lazily imports `@zama-fhe/sdk` (dynamic `import()`, so pages that never vote do not
  load it) and builds a read-only SDK: `createConfig({ chains: [mainnet preset with
  network = EIP-1193 wrapper over the private public-scope client, relayerUrl = zamaRelayerUrl ?? preset],
  provider: new ViemProvider({ publicClient }), storage: memoryStorage, telemetry: false,
  relayers: { [id]: web({ offloadEncrypt: false, batchRpcCalls: true }) } })`, then
  `sdk.encrypt({ values: [{ type: "euint8", value: choice }], contractAddress: scheme, userAddress: voter })`.
  The ballot is `encodeFheBallot(encryptedValues[0], inputProof)`.
- No webpack changes are needed: `@fhevm/sdk` compiles the TFHE WASM from an embedded base64 module, so
  the export contains only `.js` (several MB of lazy chunks, loaded on the first ballot only; the SDK then fetches the FHE public key, tens of MB, from the relayer).
  Encryption runs on the main thread (`offloadEncrypt: false`) because the SDK's worker URL is not
  rewritten by the static-export post-processing.
- What the user signs: only the `castBallot` transaction. Creating the encrypted input needs no
  signature and costs nothing; the relayer verifies the input proof off-chain. The choice never leaves
  the browser in clear.
- What leaves the browser: the SDK's host-chain reads go through the private RPC (public scope). The FHE
  public key/CRS download and the input-proof request go directly to the Zama relayer (or
  `zamaRelayerUrl`), which therefore sees the IP, the scheme and the voter address (both public in the
  transaction moments later), never the choice. This is a direct third-party request, like the wallet's
  own RPC: point `zamaRelayerUrl` at an operator proxy to avoid it.
- `VoteAdapter` (`src/lib/vote-adapter.ts`) keeps the seam: `zamaVoteAdapter` (default) and, only when the
  build sets `NEXT_PUBLIC_DEV_PLAIN_BALLOTS=true`, `plainVoteAdapter` (`encodePlainBallot`) for the mock
  scheme, marked as not private in the UI.

## Hostname routing

Every `<label>.<parent>` name resolves to the same contenthash, so the root page decides what to show.
`src/lib/host.ts` `tokenLabelFromLocation()` reads `?label=<label>` (for local testing) or parses the
gateway hostname with `parseGatewayHostname(hostname, ensParentName)` (`pepe.varada.eth.limo`,
`.eth.link`, `pepe.varada.bzz.link`). With a label, `/` renders the token page and resolves the address
through ENS (`getTokenAddressByLabel`, public-scope private RPC), then the registry, then the indexer's
`/api/tokens/by-label/:label`. Without one it renders the token list. Try it locally with
`/?label=<label>`. The plain-DNS form `verada.com/<label>` goes through `404.html`, which redirects to
`token/?label=<label>`; the token route resolves the label the same way.

## Privacy notes for these features

- Address-keyed reads (voting weight, `hasVoted`) use `createAccountClient`; the indexer and publisher
  never receive the wallet address. Controller/editor checks compare addresses in the browser.
- Uploads and logo images go to the configured publisher and Swarm gateway (operator-run), which see the
  IP, like the indexer. The Zama relayer is the one third-party service contacted directly (see Voting).

## Scripts

`pnpm --filter @verada/web typecheck | lint | test | build | verify:export | build:verify`

`verify:export` (or `node scripts/verify-export.mjs --build`) checks `out/`: no binary extensions or
content, `index.html` for every route, `404.html` and `config.json` present, no root-absolute `/_next/`
references left, runtime public path patched.
