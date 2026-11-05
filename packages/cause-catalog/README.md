# @verada/cause-catalog

Builds the cause catalogue that `CauseCatalog` commits to: every compliant Endaoment organization
with a mainnet address, classified by cause and region and bucketed into a Merkle tree. See
`docs/ARCHITECTURE.md` (Cause catalogue) for how the contracts use it.

## Pipeline

```sh
# 1. Crawl the Endaoment search API into .catalog/harvest (resumable; rerun to continue).
node packages/cause-catalog/bin/verada-catalog.mjs harvest
#    A partial crawl for reviewing the taxonomy:
node packages/cause-catalog/bin/verada-catalog.mjs harvest --max-per-partition 250

# 2. Classify, bucket and build the tree into .catalog/build.
node packages/cause-catalog/bin/verada-catalog.mjs build
node packages/cause-catalog/bin/verada-catalog.mjs stats     # per-category / region / bucket counts

# 3. Upload the snapshot to Swarm (dry run without --execute) and print the owner's calldata.
BEE_POSTAGE_BATCH_ID=... node packages/cause-catalog/bin/verada-catalog.mjs publish --execute
node packages/cause-catalog/bin/verada-catalog.mjs calldata --swarm-ref <reference>
```

`.catalog/` is git-ignored. The crawl partitions by NTEE major group, writes one JSONL file per
group plus `state.json`, and records the counts endpoint's `asOf`; `harvest` prints harvested vs
expected counts per group. Endaoment bans an IP for about ten minutes after a 429, so requests are
spaced (`--interval-ms`, default 1000) and retries back off in minutes. Ask Endaoment for a
workload-specific limit before a full crawl.

## Classification

- Categories and regions are defined once, in `packages/sdk/src/catalog.ts` (`TAXONOMY_VERSION`).
  Changing what a bit means requires a new taxonomy version and a new catalogue version.
- Specific NTEE codes map by prefix. Keywords in the name and description apply when the code is
  missing, unclassified (`Z`), major-group-only (`A00`, `E`) or international (`Q*`).
- `alwaysKeywords` (high-precision phrases such as "wrongful conviction" or "innocence project")
  apply to every org, for causes that organizations file under general codes.
- Regions come from the HQ country. International (`Q*`) orgs also get Global and every region
  their text names (unambiguous place names only).
- `region-overrides.json` corrects individual orgs, keyed by EIN digits or Endaoment id:
  `{ "orgs": { "123456789": { "regions": ["africa"], "categories": ["hunger"], "mode": "add" } } }`
  (`mode` defaults to `replace`).
- Orgs nothing places go to `other`, which tokens with an "any cause" focus include.

## Outputs

`catalog.json` (root, bucket sizes, taxonomy version, stats), `orgs.jsonl` (one org per line, with
its categories, regions and entries) and `tree.json` (the OpenZeppelin `StandardMerkleTree` dump).
`contractFixture()` and `pnpm gen:fixture` regenerate `contracts/test/fixtures/catalog.json`, which
the Solidity tests verify against `CauseCatalog` so the two implementations cannot drift.
