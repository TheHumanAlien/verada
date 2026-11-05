/**
 * Manual mainnet check of the keeper's decrypt + submit path for one closed poll. This spends
 * real ETH (gas) and Zama fees; use E2E_DRY_RUN=true first.
 *
 *   ETH_RPC_URL=... KEEPER_PRIVATE_KEY=0x... VOTING_SCHEME_ADDRESS=0x... \
 *   E2E_GOVERNOR=0x... E2E_TOKEN=0x... E2E_SCOPE=<epoch or proposal id> \
 *   pnpm --filter @verada/publisher e2e:zama
 *
 * Optional: ZAMA_RELAYER_URL, ZAMA_RELAYER_API_KEY, E2E_DRY_RUN=true (decrypt and estimate only).
 * The poll must already be closed (`closeEpoch` / `closeProposal`) so its tallies are publicly
 * decryptable. Prints the decrypted per-option totals (public once submitted), the gas estimate
 * and the gas used. Never prints the key or the RPC URL.
 */
import { zamaVotingSchemeAbi } from "@verada/sdk/abis";
import { getAddress, type Hex } from "viem";
import { redact } from "../src/keeper/chain.js";
import { checkDecryption, createZamaDecryptor, ZAMA_CHAIN_IDS } from "../src/keeper/decrypt.js";
import { createViemChain } from "../src/keeper/viem-chain.js";

const need = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
};

async function main() {
  const rpcUrl = need("ETH_RPC_URL");
  const privateKey = need("KEEPER_PRIVATE_KEY") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte key");
  const scheme = getAddress(need("VOTING_SCHEME_ADDRESS"));
  const governor = getAddress(need("E2E_GOVERNOR"));
  const token = getAddress(need("E2E_TOKEN"));
  const scope = BigInt(need("E2E_SCOPE"));
  const dryRun = /^(1|true|yes)$/i.test(process.env.E2E_DRY_RUN ?? "");

  const chain = createViemChain({
    chainId: ZAMA_CHAIN_IDS.mainnet,
    rpcUrls: [rpcUrl],
    privateKey,
    epochGovernor: governor,
    takeoverGovernor: governor,
  });
  const chainId = await chain.publicClient.getChainId();
  if (chainId !== ZAMA_CHAIN_IDS.mainnet) throw new Error(`RPC is on chain ${chainId}, expected Ethereum mainnet`);
  console.log("keeper", chain.writer.account);

  const closed = (await chain.publicClient.readContract({
    address: scheme,
    abi: zamaVotingSchemeAbi,
    functionName: "isClosed",
    args: [governor, token, scope],
  })) as boolean;
  const before = await chain.reader.tallyOf(scheme, governor, token, scope);
  if (before.isFinal) {
    console.log("tally already final", before.counts.map(String));
    return;
  }
  if (!closed) throw new Error("poll is not closed; close the epoch or proposal first");

  const handles = await chain.reader.tallyHandles(scheme, governor, token, scope);
  console.log("handles", handles.length);
  const decryptor = createZamaDecryptor({
    chainId: ZAMA_CHAIN_IDS.mainnet,
    publicClient: chain.publicClient,
    rpcUrl,
    relayerUrl: process.env.ZAMA_RELAYER_URL || undefined,
    apiKey: process.env.ZAMA_RELAYER_API_KEY || undefined,
  });
  const t0 = Date.now();
  const r = await decryptor.publicDecrypt(handles);
  const { cleartexts, values } = checkDecryption(handles, r);
  console.log("decrypted in", `${((Date.now() - t0) / 1000).toFixed(1)}s`, values.map(String));
  decryptor.dispose?.();

  const action = { kind: "submitTally" as const, scheme, governor, token, scope, cleartexts, proof: r.decryptionProof };
  const gas = await chain.writer.estimate(action);
  console.log("gas estimate", gas.toString());
  if (dryRun) return;

  const tx = await chain.writer.send(action, (gas * 120n) / 100n);
  console.log("submitTally", tx.hash, tx.status, "gasUsed", tx.gasUsed.toString());
  const after = await chain.reader.tallyOf(scheme, governor, token, scope);
  console.log("tally final", after.isFinal, after.counts.map(String));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const name = err instanceof Error ? err.name : "Error";
    const errorName = (err as { errorName?: string }).errorName;
    console.error(name, errorName ?? "", redact(err instanceof Error ? err.message : String(err), 500));
    process.exit(1);
  },
);

