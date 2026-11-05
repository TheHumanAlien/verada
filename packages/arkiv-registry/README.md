# @verada/arkiv-registry

Mirrors Verada's public token and cause records onto [Arkiv](https://arkiv.network) so anyone can
query them without the Verada indexer. Built on `@arkiv-network/sdk` 1.0.1 (viem clients extended
with Arkiv actions). **Arkiv is testnet only (Rabdi, chain id 7794095).** Treat the mirror as a
convenience copy; Ethereum mainnet remains the source of truth.

## Schemas

| Schema (`arkiv.schema` tag) | Column | Type | Indexed | Notes |
|---|---|---|---|---|
| `verada.token` (`TokenCore`) | `token` | addr | yes | token contract |
| | `chainId` | u64 | yes | `1` for mainnet |
| | `poolId` | str | yes | Uniswap v4 pool id, lowercase hex |
| | `creator` | addr | yes | launcher |
| | `launchBlock` | u64 | | Ethereum block of `TokenCreated` |
| | `label` | str | yes | ENS label (`<label>.varada.eth`) |
| | `metadataUri` | str | | `bzz://<ref>` (empty if it does not fit 128 bytes) |
| | `logoRef` | str | | launch logo, 64-hex Swarm reference |
| | `causeCategory` | str | yes | reserved, empty |
| | `version` | i32 | | `SCHEMA_VERSION` (1) |
| `verada.token-profile` (`TokenProfile`) | `core` | key | yes | entity key of the token's `TokenCore` |
| | `token`, `chainId` | addr, u64 | yes | |
| | `controller` | addr | yes | ENS subname controller (creator by default) |
| | `editor` | addr | | delegated editor (zero address when none) |
| | `website`, `twitter`, `telegram`, `discord` | str, optional | | ENS text records `url`, `com.twitter`, `org.telegram`, `com.discord` |
| | `description` | bytes, optional | | UTF-8, capped at 8 KiB |
| | `logoRef` | str, optional | | current logo |
| | `contenthash` | str, optional | | EIP-1577 hex |
| | `updatedAtBlock` | u64 | | Ethereum block of the last profile change |
| `verada.cause` (`Cause`) | `causeId` | str | yes | on-chain cause id (bytes32 hex) |
| | `orgId` | str | yes | Endaoment org id (empty until the indexer serves it) |
| | `ein` | str, optional | | |
| | `orgAddress` | addr | yes | payout address |
| | `name` | str | | truncated to 128 UTF-8 bytes |
| | `nteeCode` | str, optional | | |
| | `active` | bool | yes | |

Arkiv limits: at most 32 attributes per entity, `str` at most 128 UTF-8 bytes (`truncateStr` and
`fitStr` handle this: free text is truncated on a code point boundary, URLs that do not fit are
left out rather than cut), `bytes` at most 128 KiB.

## Trust model

- **Check `$creator`.** The `arkiv.schema` tag is just an attribute, and anyone can write an entity
  with `arkiv.schema = "verada.token"`. Readers must filter on `$creator == <platform address>`
  (`.createdBy(platform)`). `$creator` is set by the chain and cannot change. The registry only ever
  lists entities created by its own signer.
- **Cores are immutable.** A `TokenCore` is created with the `readonly` flag, so its attributes can
  never be patched. It is then handed to `BURN_OWNER` (`0x…dEaD`; Arkiv rejects the zero address as a
  new owner) in a second transaction, so nobody, the platform included, can delete it or hand it on.
  If a run stops between the two transactions, the next reconcile sees a core not owned by
  `BURN_OWNER` and burns it (`plan.burns`). Because a core cannot be fixed later, tokens are not
  mirrored until the indexer reports a valid ENS label (`plan.deferred`); cores whose launch facts
  disagree with the indexer are reported in `plan.conflicts`, never rewritten.
- **Profiles and causes are mutable** and stay owned by the platform, which patches them as the
  on-chain records change.

## Expiry and renewal

Arkiv entities expire. The longest lifetime is `MAX_LIFETIME` = 7,884,000 blocks, about 182.5 days at
2 s blocks; the registry creates and extends with `ExpirationTime.max()`. Every entity is created
with `permissionlessExtension`, so anyone (not only the platform, and in particular not only the
burned core's "owner") can keep it alive. The publisher's `arkiv-extend` job extends entities that
expire within 30 days. `planReconcile` lists them in `plan.extends` too.

## API

```ts
import { applyPlan, createArkivRegistry, planReconcile } from "@verada/arkiv-registry";

const registry = createArkivRegistry({ chain: "rabdi", accessKey, privateKey, dryRun: true });
const plan = planReconcile({
  chainId: 1,
  indexerTokens, indexerCauses,                      // parsed with IndexerTokenSchema / IndexerCauseSchema
  existingCores: await registry.listCores(),
  existingProfiles: await registry.listProfiles(),
  existingCauses: await registry.listCauses(),
  currentBlock: await registry.currentBlock(),
  renewBeforeBlocks: 1_296_000n,                     // 30 days of 2 s blocks
});
await applyPlan(registry, plan);
```

- Pure (`mapping.ts`): `toTokenCore`, `toProfileDraft`, `toTokenProfile`, `toCause`, `truncateStr`,
  `fitStr`, `diffProfile`, `diffCause`, `planReconcile`, `expiringKeys`.
- Client (`client.ts`): `listCores/listProfiles/listCauses` (keyset pagination: `ORDER BY $key` and
  `$key > last`), `createTokenRecords`, `createProfile`, `burnCores`, `patchProfile`,
  `extendExpiring`, `upsertCause`, `patchCause`. With `dryRun`, every write logs what it would do
  and sends nothing.
- The access key travels in the RPC URL path, so `registry.redact()` strips it from error messages;
  `applyPlan` logs only redacted errors. The private key is never logged.
- `@verada/arkiv-registry/testing` exports `FakeArkiv`, an in-memory stand-in for both clients.
