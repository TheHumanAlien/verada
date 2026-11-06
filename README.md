# Verada

A memecoin launchpad on Ethereum Mainnet. Trading fees fund nonprofits: each week, holders vote
(with hidden ballots) on which cause (sourced from Endaoment) receives the accumulated funds. The
platform keeps a small, fixed share of fees. Every token gets an ENS subname (`<label>.varada.eth`)
with an editable profile and a page on the Swarm-hosted app.

## Layout
- `contracts/` — Foundry (Uniswap v4 hook-based launch, fee vault, causes, weekly governance,
  ENS profile registry and wildcard resolver, Zama FHE voting scheme, community takeover)
- `packages/` — shared TypeScript (`sdk`, `endaoment-client`, `publish` for Swarm/ENS releases,
  `arkiv-registry` for the Arkiv mirror)
- `services/` — `indexer` (Ponder + read-only API) and `publisher` (uploads, Arkiv mirror, tally keeper)
- `apps/web/` — static-export frontend (served from Swarm behind ENS)
- `infra/` — AWS CDK (indexer, Bee node + gateway, publisher)

See `docs/ARCHITECTURE.md` for how the pieces fit together.

## Getting started

The original artwork in `apps/web/assets-src/` is stored with [Git LFS](https://git-lfs.com).
Install it once per machine before cloning, or the art files arrive as small text pointers:

```sh
brew install git-lfs        # or your platform's package
git lfs install             # once per machine
git clone https://github.com/camdengrieh/verada.git
cd verada && git lfs pull   # only needed if you cloned before installing LFS
pnpm install
```

Nothing that builds or ships the app needs LFS: the optimised images in `apps/web/public/assets/` are
normal git files. You only need the LFS originals to add or regenerate art (see
[`apps/web/README.md`](apps/web/README.md#art-and-assets)).
