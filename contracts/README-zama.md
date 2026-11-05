# Zama FHEVM voting scheme

`src/governance/ZamaVotingScheme.sol` implements `IVotingScheme` with encrypted ballots: a voter
submits an encrypted option index (`euint8`) and the scheme adds the voter's weight to every
option's encrypted `euint64` tally under an encrypted equality test. Nobody learns a choice; only
the final per-option totals are decrypted, after the governor closes the poll.

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
| 11155111 (Sepolia) | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` | `0x92C920834Ec8941d2C77D188936E1f7A6f49c127` | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` |
| 31337 (local) | `0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D` | `0xe3a9105a3a932253A70F126eb1E3b589C643dD24` | `0x901F8942346f7AB3a01F6D7613119Bca447Bb030` |

Any other chain reverts `ZamaProtocolUnsupported` at deployment. The addresses come from the
installed `@fhevm/solidity/config/ZamaConfig.sol`; re-verify them on every library upgrade.

## Lifecycle

1. **open** (governor): `open(token, scope, optionCount)` with `2 <= optionCount <= 10`. Each tally
   starts as a trivial encryption of zero that the scheme allows itself to reuse.
2. **castBallot** (voter, directly): the relayer SDK encrypts the option index for
   `(voter, scheme)` and returns an external handle plus an input proof. The ballot is
   `abi.encode(bytes32 handle, bytes inputProof)`. The scheme calls
   `IBallotGovernor(governor).authorizeBallot(token, scope, voter, ballotRef)` for the weight (the
   governor may open the poll lazily in that call), then `FHE.fromExternal` binds the proof to the
   voter and the weight is added to each tally through `FHE.select(FHE.eq(choice, i), w, 0)`. An
   out-of-range index adds nothing anywhere.
3. **requestTally** (governor): closes the poll and calls `FHE.makePubliclyDecryptable` on every
   tally.
4. **submitTally** (anyone): the keeper reads `tallyHandles(governor, token, scope)`, calls the
   relayer SDK `publicDecrypt(handles)` and relays the result:
   `submitTally(governor, token, scope, cleartexts, decryptionProof)`. `cleartexts` is the
   ABI-encoded list of decrypted values in handle order, one 32-byte word per tally, exactly as the
   SDK returns it. `FHE.checkSignatures` verifies the KMS signatures against
   `(handles, cleartexts)` and reverts `InvalidKMSSignatures` otherwise; the scheme then requires
   `cleartexts.length == 32 * optionCount`, each word to fit `uint64`, stores the counts and emits
   `TallySubmitted`.

## Testing

- `test/governance/ZamaVotingScheme.t.sol` runs against mocks etched at the local coprocessor
  addresses (`test/mocks/ZamaMocks.sol`). The executor mock returns typed pseudo-handles and
  enforces ACL access like the real one but performs no FHE arithmetic, so tally values cannot be
  checked there; the KMS mock accepts or rejects on demand.
- `test/fork/ZamaScheme.t.sol` forks Sepolia (`SEPOLIA_RPC_URL`) and runs `open` and
  `requestTally` against the live contracts. It is skipped when the variable is unset.
  `castBallot` needs a relayer-produced input proof and is covered by the live script instead.

## Limits and cost

- Options per poll: 10 (`MAX_OPTIONS`). Weight is whole tokens (`uint64`), one ballot per voter per
  poll.
- Each ballot runs one `fromExternal`, two trivial encryptions and, per option, one `eq`, one
  `select` and one `add`: about `10 x (eq + select + add)` HCU at ten options, plus ACL writes.
  Measured with the mocks (symbolic handles only, not representative of a real coprocessor):
  about 1.05M gas for 2 options and 2.93M for 10. Measure on Sepolia before committing to the
  per-option layout.
- Follow-up if a 10-option ballot exceeds roughly 1M gas on Sepolia: pack the tallies into two
  `euint256` accumulators with 40-bit lanes (five lanes each). A ballot then becomes one encrypted
  shift of the weight into the chosen lane and two `add`s instead of ten `eq`/`select`/`add`
  triples, and the decryption yields two words to unpack on-chain. The 40-bit lane bounds total
  weight per option at about 1.1e12 whole tokens, which is above the fixed supply.
