# Privacy and CROPS

Verada aims to meet the Ethereum Foundation's CROPS properties: **C**ensorship resistance,
**O**pen source, **P**rivacy and **S**ecurity. This document covers how the web app keeps what a
user looks at private, what it cannot protect, and where each CROPS property stands today.

## Private RPC (anon-rpc)

Every chain read the web app makes goes through [anon-rpc](https://github.com/ethereum/anon-rpc).
anon-rpc runs an anonymizing network client (Nym by default, Tor optional) inside a sandboxed
worker in the browser, and the app sends its RPC requests through that client.

### What it protects

When a user views data tied to their address, such as a portfolio, donations made or votes cast:

- **The RPC provider never sees the user's IP address.** Requests leave the mixnet from an exit
  node, so the provider sees the exit's address, not the user's.
- **Verada never sees the request at all.** Account data is read from the chain in the browser,
  never from the Verada indexer, and the web app never sends a user's address to Verada servers.
- **A user's accounts cannot be linked to each other through their queries.** Each address gets
  its own random isolation key, which asks the network to keep that address's traffic unlinkable
  from other addresses' traffic. Keys exist only in memory and change on every page load.
- **Account queries never fall back to a direct connection.** If the anonymizing network is down,
  account data does not load. The user can choose to load *public* data (token lists, epochs)
  directly, but that choice never applies to account-scoped requests.

Without this, an RPC provider (Infura, Alchemy or a public endpoint) could record "IP X looked up
the donations and votes of address Y". Over time that ties a person's location and identity to
their whole on-chain history.

### How it works

| Piece | Where | Role |
|---|---|---|
| `src/lib/private-rpc.ts` | `PrivateRpc` | Owns the anon-rpc worker, isolation keys, fail-closed policy and the viem transport. |
| `src/lib/account-reads.ts` | `createAccountClient` | The only sanctioned way to read address-keyed data. |
| `src/lib/wagmi.ts` | wagmi transport | wagmi reads go through the private RPC, isolated under the connected account. |
| `src/lib/chain-reads.ts` | `createChainClient` | Public-scope chain reads (the indexer fallback). |
| `src/components/privacy-status.tsx` | header | Shows connection state, allows a retry, and lets the user route indexer traffic privately too. |

The harness checks the worker bundle against a keccak256 hash pinned in an on-chain specifier
contract, and only then runs it. The worker runs in a Web Worker inside a null-origin iframe with
no access to the page, cookies, storage or keys.

Configure it in `config.json` under `privateRpc`, or with the `NEXT_PUBLIC_ANON_RPC_NETWORK` and
`NEXT_PUBLIC_PRIVATE_RPC_URLS` variables:

```json
{
  "privateRpc": {
    "network": "nym",
    "rpcUrls": ["https://ethereum-rpc.publicnode.com", "https://ethereum.reth.rs/rpc"]
  }
}
```

For Tor, set `"network": "tor-js"` and give a `workerConfig` with `gateways`. Run your own gateway:
the published one is a demonstration.

### Measured cost

Measured in Chrome on 2026-11-05 through Nym:

- The worker was ready about 8 seconds after start.
- Each `eth_blockNumber` took about 6 seconds.

`ethereum.reth.rs` and `publicnode.com` answered. Llamarpc (HTTP 525) and Cloudflare refused
mixnet traffic. The app batches JSON-RPC calls and lists several RPCs for failover. The worker
starts on the first chain read, or straight away once a wallet connects.

### What it does not protect

- **Transactions.** Votes, launches and donations are signed and broadcast by the user's wallet
  through the wallet's own RPC, which this app does not control. That RPC sees the signed
  transaction and the user's IP. Users who want this hidden should set a private or
  Tor-routed RPC in their wallet.
- **On-chain data is public.** anon-rpc hides who is asking, not what is on-chain. A ballot's
  voter and weight are public; the choice is encrypted (Zama FHEVM through `IVotingScheme`) and
  only per-option totals are ever decrypted. With very few voters the totals can still reveal a
  choice.
- **The Zama relayer.** Encrypting a ballot fetches the FHE public key and an input proof from
  Zama's relayer directly (the SDK has no fetch hook, so this cannot go through anon-rpc). The
  relayer sees the IP, the scheme address and the voter address, never the choice. Operators can
  put a proxy in front with `zamaRelayerUrl`.
- **The bootstrap read.** One direct `eth_call` reads the specifier contract, and the worker
  bundle is downloaded from the specifier's resolver (currently jsDelivr). These reveal only that
  this IP is starting an anon-rpc worker.
- **The worker itself.** The worker sees every read it carries, and it could lie or drop requests.
  Trust rests with whoever controls the specifier contract (for the default, the Nym project).
  The pinned hash makes that code auditable and stops silent substitution.
- **Site delivery.** The ENS or Swarm gateway that serves the page sees the page load.
- **Indexer traffic, unless routed.** Public pages read the Verada indexer directly by default.
  The indexer sees the IP and which token pages were viewed while serving the request, but never
  a wallet address, and it keeps no access logs. Users can
  turn on "Also route Verada API requests" to hide their IP from Verada as well.

## Rules for new features

1. Never send a user's address to the Verada indexer or any other server. Read account data
   with `createAccountClient(rpc, address)`, or fetch public data and filter it in the browser.
2. Do not create viem clients with a plain `http()` transport. Use `rpc.transport(scope)`.
3. Do not add analytics, third-party fonts, CDNs or tracking. The app makes no third-party
   requests apart from the RPCs and the anon-rpc bootstrap.
4. `EventSource` cannot use a custom fetch. When indexer traffic is routed privately, use
   `subscribeActivity(..., { sse: false })`.

## CROPS assessment

Status as of 2026-11-05. Gaps are listed with the change that would close each one.

### Censorship resistance

| Item | Status |
|---|---|
| Static export served from Swarm/ENS with relative paths; no app server to take down | Met |
| Indexer failover list, with chain reads as the fallback for core data | Met |
| RPC failover across several providers, all reached through anon-rpc | Met |
| Indexer runs on a single AWS account | Gap: publish the indexer image and config so others can run mirrors, and list them in `indexerUrls` |
| The anon-rpc worker bundle is served from one resolver (jsDelivr) | Gap, upstream: the specifier owner controls resolvers. We could publish our own specifier with extra resolvers |

### Open source

| Item | Status |
|---|---|
| Dependencies are open source (anon-rpc is MIT) | Met |
| Verada's own code has no license file | **Gap: add a LICENSE at the repo root (choice pending)** |
| Builds are reproducible against the published Swarm hash | Gap: document the build-to-hash check |

### Privacy

| Item | Status |
|---|---|
| Chain reads via anon-rpc, per-account isolation, account reads fail closed | Met |
| No analytics, third-party fonts or WalletConnect relay | Met |
| Optional private routing for indexer traffic | Met |
| Ballot choices are hidden (Zama FHE scheme); voter and weight are public | Met; trust in Zama's threshold KMS. Interfold or a self-hosted scheme can replace it behind `IVotingScheme` |
| Zama relayer sees the voter's IP and address when encrypting a ballot | Gap: documented; `zamaRelayerUrl` allows an operator proxy |
| Transactions go through the wallet's RPC | Out of the app's control; documented above |
| No indexer ALB access logs, so client IPs and request paths are never stored (enforced by an infra test). The per-IP rate limiter keeps IPs only in memory, briefly | Met |

### Security

| Item | Status |
|---|---|
| anon-rpc worker hash-pinned and sandboxed (null-origin iframe, no key access) | Met |
| Signing stays in the user's wallet; the anon worker never sees signed transactions | Met |
| Indexer CORS allowlist applied in prod (fixed: infra now sets `CORS_ALLOWED_ORIGINS`, the variable the indexer reads) | Met |
| No Content Security Policy (static export cannot set headers) | Gap: add a `<meta http-equiv="Content-Security-Policy">`; anon-rpc then needs `iframeUrl` pointing at a same-origin bootstrap page |
| Trust in the worker's read results | Gap: cross-check critical reads (for example, values a transaction depends on) against a second RPC |
