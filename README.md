# Verada

A memecoin launchpad on Ethereum Mainnet. Trading fees fund nonprofits: each week, holders vote on
which cause (sourced from Endaoment) receives the accumulated funds. The platform keeps a small,
fixed share of fees.

## Layout
- `contracts/` — Foundry (Uniswap v4 hook-based launch, fee vault, causes, weekly governance)
- `packages/` — shared TypeScript (`sdk`, `endaoment-client`)
- `services/` — indexer / API
- `apps/web/` — functional frontend skeleton
- `infra/` — AWS CDK
