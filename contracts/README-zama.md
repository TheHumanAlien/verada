# Zama FHEVM voting scheme

`src/governance/ZamaVotingScheme.sol` implements `IVotingScheme` with encrypted ballots: a voter
submits an encrypted option index (`euint8`) and the scheme adds the voter's weight to the chosen
option's counter inside packed encrypted `euint128` tally words, touching every word under an
encrypted equality test. Nobody learns a choice; only the final totals are decrypted, after the
governor closes the poll.

## Dependencies

The Zama library is an npm package, resolved through Foundry remappings. It is installed
separately from the root pnpm workspace so the root lockfile stays untouched:

```sh
cd contracts
pnpm install --frozen-lockfile --ignore-workspace   # or: pnpm run install:deps
forge build
```

`contracts/package.json` pins `@fhevm/solidity@0.13.4` and `encrypted-types@0.0.4`;
`contracts/pnpm-lock.yaml` is committed, `contracts/node_modules` is ignored. `foundry.toml` maps
`@fhevm/solidity/` and `encrypted-types/` to `node_modules/`. CI installs them in the `contracts`
job before `forge build`.

## Coprocessor routing

The constructor calls `FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig())`, which
selects the ACL, coprocessor (FHEVMExecutor) and KMSVerifier addresses by `block.chainid`:

| chain | ACL | Coprocessor | KMSVerifier |
|---|---|---|---|
| 1 (mainnet) | `0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6` | `0xD82385dADa1ae3E969447f20A3164F6213100e75` | `0x77627828a55156b04Ac0DC0eb30467f1a552BB03` |
| 31337 (local) | `0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D` | `0xe3a9105a3a932253A70F126eb1E3b589C643dD24` | `0x901F8942346f7AB3a01F6D7613119Bca447Bb030` |

Any other chain reverts `ZamaProtocolUnsupported` at deployment. The addresses come from the
installed `@fhevm/solidity/config/ZamaConfig.sol`; re-verify them on every library upgrade.

## Lifecycle

1. **open** (governor): `open(token, scope, optionCount)` with `2 <= optionCount <= 32`. The
   tallies are packed: `ceil(optionCount / 3)` `euint128` words, each holding three 40-bit counters
   (option `i` lives in word `i / 3` at bit `40 * (i % 3)`). `open` only records the option count
   and runs no FHE operation (about 30k gas): the words are created lazily by the first ballot, so
   an epoch nobody votes in never pays for encrypted state.
2. **castBallot** (voter, directly): the relayer SDK encrypts the option index for
   `(voter, scheme)` and returns an external handle plus an input proof. The ballot is
   `abi.encode(bytes32 handle, bytes inputProof)`. The scheme calls
   `IBallotGovernor(governor).authorizeBallot(token, scope, voter, ballotRef)` for the weight (the
   epoch must already be opened by `openEpoch`/`prepareBallot`; otherwise the governor reverts
   `EpochNotOpened`), then `FHE.fromExternal` binds the proof to the voter. The weight is shifted into the chosen slot once
   (`shl(asEuint128(w), 40 * (choice % 3))`) and added to every word under an encrypted test of the
   word index (`select(eq(choice / 3, j), shifted, 0)`), so the chain never learns which word or
   slot changed. An out-of-range index lands in an unused slot of the last word or in no word.
   The first ballot of a poll creates the words: each starts as that ballot's selected
   contribution (what adding it to an encrypted zero would give) and is allowed to the scheme.
   Every ballot writes every word whatever its choice, so the lazy start reveals nothing.
3. **requestTally** (governor): closes the poll and calls `FHE.makePubliclyDecryptable` on every
   tally word. A poll closed without ballots has no words: it is final at once with all-zero
   counts (`TallySubmitted` is emitted here and `tallyOf` returns `optionCount` zeros), so it needs
   no decryption and `submitTally` reverts `TallyAlreadyFinal` for it.
4. **submitTally** (anyone): the keeper reads `tallyHandles(governor, token, scope)`, calls the
   relayer SDK `publicDecrypt(handles)` and relays the result:
   `submitTally(governor, token, scope, cleartexts, decryptionProof)`. `cleartexts` is the
   ABI-encoded list of decrypted values in handle order, one 32-byte word per tally word, exactly as
   the SDK returns it. `FHE.checkSignatures` verifies the KMS signatures against
   `(handles, cleartexts)` and reverts `InvalidKMSSignatures` otherwise; the scheme then requires
   `cleartexts.length == 32 * words`, each word to fit 120 bits, unpacks the per-option counts,
   stores them and emits `TallySubmitted`.

## Testing

- `test/governance/ZamaVotingScheme.t.sol` runs against mocks etched at the local coprocessor
  addresses (`test/mocks/ZamaMocks.sol`). The executor mock returns typed pseudo-handles, enforces
  ACL access like the real one and shadows every handle with the plaintext it would hold, so the
  packed tallies are checked end to end (including a fuzz test against a plain per-option
  reference and a 32-option catalogue ballot in `CatalogZamaIntegration.t.sol`); the KMS mock
  accepts or rejects on demand.
- `test/fork/ZamaScheme.t.sol` forks mainnet (`ETH_RPC_URL`) and runs `open`, a first ballot and
  `requestTally` against the live contracts (and `requestTally` without ballots), and measures one
  ballot's accumulation on a trivially encrypted choice through a harness, so the live
  coprocessor's HCU limits apply to the exact operations of a ballot. `test_fork_lazyVsEagerTallyCost`
  replays the old eager `open` (`test/utils/EagerTallyScheme.sol`) next to the lazy one. It is skipped when the variable is unset. `castBallot` itself needs a
  relayer-produced input proof and is covered by the live script instead.

## Limits and cost

- Options per poll: 32 (`MAX_OPTIONS`). Weight is whole tokens, at most `2^40 - 1` per ballot
  (`MAX_WEIGHT`), one ballot per voter per poll. A counter holds at most `2^40 - 1` (1.1e12 whole
  tokens); the fixed supply of a Verada token is 1e11 whole tokens, so a poll's total weight cannot
  overflow into a neighbouring counter.
- Each ballot runs one `fromExternal`, one `div`, `rem` and `mul` on the `euint8` choice, one
  cast and `shl` to place the weight, and then one `eq`, `select` and `add` per word: 11 words at
  32 options instead of 32 per-option triples. The first ballot skips the `add` and creates the
  word instead.
- Lazy tallies, measured on a mainnet fork against the live coprocessor
  (`test_fork_lazyVsEagerTallyCost`, 2026-11-06, every step from cold accounts and slots,
  execution gas): `open` went from 140k / 256k / 526k gas at 2 / 10 / 32 options to 30k, saved
  on every prepared epoch. The first voter pays for creating the words instead: 267k -> 292k,
  517k -> 544k and 1.101M -> 1.132M (about +25k to +31k, bounded by one fresh slot per word);
  later ballots are unchanged (1.084M at 32 options). The in-test figures slightly undercount
  rewrites of slots an earlier step wrote (`test/utils/ColdGas.sol`); run as separate
  transactions (`forge test --isolate`, base and calldata included) the first ballot goes
  304k -> 324k, 554k -> 576k and 1.138M -> 1.164M (about +20k to +26k). With the local mocks,
  the platform's transactions per token-week (`test_gas_weeklyPlatform_eagerVsLazyTallies`) drop
  by the same `open` cost for idle, traded-but-unvoted and voted epochs alike.
- Measured on a mainnet fork against the live coprocessor (`test_fork_ballotCost`, accumulation
  only, 2026-11-06): about 185k gas at 2 options, 421k at 10, 735k at 24 and 971k at 32, all within
  the coprocessor's per-transaction HCU limits. A whole ballot on the same live contracts, with
  the input proof replaced by a trivial encryption and a stub governor (`test_fork_castBallotCost`),
  costs about 292k gas at 2 options, 544k at 10 and 1.13M at 32 for a poll's first ballot (which
  creates the tally words; measured from cold accounts and slots after `open`); `InputVerifier.verifyCiphertext`
  (3-of-5 coprocessor signatures on mainnet) and the real governor's `authorizeBallot` come on top.
  By the published HCU table a 32-option ballot is about 5.1M HCU per transaction (limit 20M on
  mainnet, read from `HCULimit.getMaxHCUPerTx`) with a longest dependency chain of about 1.15M
  (depth limit 5M). The per-option layout this replaced cost about 2.93M gas at 10 options with
  the mocks.
