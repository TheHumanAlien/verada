import { epochGovernorAbi, takeoverGovernorAbi, veradaFactoryAbi, zamaVotingSchemeAbi } from "@verada/sdk/abis";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { ballotCall, createBallotReader } from "@verada/sdk";
import type { BallotReader } from "./ballot.js";
import {
  KeeperRevert,
  PROPOSAL_STATES,
  type ChainReader,
  type ChainWriter,
  type FactoryLogReader,
  type KeeperAction,
} from "./chain.js";

export interface ViemChainOptions {
  chainId: number;
  /** Tried in order (viem fallback transport); JSON-RPC batching is on. */
  rpcUrls: string[];
  privateKey: Hex;
  epochGovernor: Address;
  takeoverGovernor: Address;
  factory?: Address;
  /** Blocks per `eth_getLogs` request in the factory scan. */
  logChunk?: bigint;
  receiptTimeoutMs?: number;
}

export function chainFor(chainId: number, rpcUrls: string[]): Chain {
  if (chainId === mainnet.id) return mainnet;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
}

export function transportFor(rpcUrls: string[]): Transport {
  if (rpcUrls.length === 0) throw new Error("no RPC URL");
  const one = (u: string) => http(u, { batch: true, timeout: 30_000, retryCount: 2 });
  return rpcUrls.length === 1 ? one(rpcUrls[0]!) : fallback(rpcUrls.map(one));
}

/** Decoded custom error name of a revert, if any. Arguments are never kept (they may name voters). */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? r.reason;
  return undefined;
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** viem-backed {@link ChainReader}, {@link ChainWriter} and factory log reader. */
export function createViemChain(opts: ViemChainOptions): {
  reader: ChainReader;
  writer: ChainWriter;
  ballots: BallotReader;
  factoryLogs?: FactoryLogReader;
  publicClient: PublicClient;
} {
  const chain = chainFor(opts.chainId, opts.rpcUrls);
  const transport = transportFor(opts.rpcUrls);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(opts.privateKey);
  const wallet = createWalletClient({ chain, transport, account });
  const eg = opts.epochGovernor;
  const tg = opts.takeoverGovernor;

  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  const reader: ChainReader = {
    currentEpoch: () => read<bigint>(eg, epochGovernorAbi, "currentEpoch"),
    isRegistered: (token) => read<boolean>(eg, epochGovernorAbi, "isRegistered", [token]),
    async epoch(token, epoch) {
      const [opened, closed, finalized, voterCount, scheme] = await Promise.all([
        read<boolean>(eg, epochGovernorAbi, "isOpened", [token, epoch]),
        read<boolean>(eg, epochGovernorAbi, "isClosed", [token, epoch]),
        read<boolean>(eg, epochGovernorAbi, "isFinalized", [token, epoch]),
        read<bigint>(eg, epochGovernorAbi, "voterCount", [token, epoch]),
        read<Address>(eg, epochGovernorAbi, "epochScheme", [token, epoch]),
      ]);
      return { opened, closed, finalized, voterCount, scheme };
    },
    async tallyOf(scheme, governor, token, scope) {
      const [isFinal, counts] = await read<readonly [boolean, readonly bigint[]]>(scheme, zamaVotingSchemeAbi, "tallyOf", [governor, token, scope]);
      return { isFinal, counts };
    },
    tallyHandles: (scheme, governor, token, scope) => read<readonly Hex[]>(scheme, zamaVotingSchemeAbi, "tallyHandles", [governor, token, scope]),
    proposalCount: () => read<bigint>(tg, takeoverGovernorAbi, "proposalCount"),
    async proposal(id) {
      const [p, state, closed, scheme] = await Promise.all([
        read<{ token: Address; tallied: boolean }>(tg, takeoverGovernorAbi, "getProposal", [id]),
        read<number>(tg, takeoverGovernorAbi, "state", [id]),
        read<boolean>(tg, takeoverGovernorAbi, "isClosed", [id]),
        read<Address>(tg, takeoverGovernorAbi, "proposalScheme", [id]),
      ]);
      const s = PROPOSAL_STATES[state];
      if (!s) throw new Error(`unknown proposal state ${state}`);
      return { token: p.token, tallied: p.tallied, state: s, closed, scheme };
    },
  };

  const toCall = (a: KeeperAction): Call => {
    switch (a.kind) {
      case "openEpoch":
      case "prepareBallot":
      case "prepareCuratedBallot":
        return ballotCall(a, eg);
      case "closeEpoch":
      case "finalizeEpoch":
        return { address: eg, abi: epochGovernorAbi, functionName: a.kind, args: [a.token, a.epoch] };
      case "submitTally":
        return { address: a.scheme, abi: zamaVotingSchemeAbi, functionName: "submitTally", args: [a.governor, a.token, a.scope, a.cleartexts, a.proof] };
      case "closeProposal":
      case "recordTally":
      case "execute":
        return { address: tg, abi: takeoverGovernorAbi, functionName: a.kind, args: [a.id] };
    }
  };

  const writer: ChainWriter = {
    account: account.address,
    async estimate(action) {
      try {
        return await publicClient.estimateContractGas({ ...toCall(action), account } as never);
      } catch (err) {
        const name = revertName(err);
        if (name !== undefined || (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError))) {
          throw new KeeperRevert(name, `${action.kind} would revert`);
        }
        throw err;
      }
    },
    async send(action, gas) {
      const hash = await wallet.writeContract({ ...toCall(action), gas, chain, account } as never);
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: opts.receiptTimeoutMs ?? 5 * 60_000 });
      return { hash, status: r.status, gasUsed: r.gasUsed };
    },
  };

  let factoryLogs: FactoryLogReader | undefined;
  if (opts.factory) {
    const factory = opts.factory;
    const chunk = opts.logChunk ?? 10_000n;
    const event = veradaFactoryAbi.find((x) => x.type === "event" && x.name === "TokenCreated");
    if (!event || event.type !== "event") throw new Error("TokenCreated missing from the factory ABI");
    factoryLogs = {
      async tokensCreated(fromBlock) {
        const latest = await publicClient.getBlockNumber();
        const tokens: Address[] = [];
        for (let start = fromBlock; start <= latest; start += chunk) {
          const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
          const logs = await publicClient.getLogs({ address: factory, event, fromBlock: start, toBlock: end, strict: true });
          for (const l of logs) tokens.push((l.args as { token: Address }).token);
        }
        return { tokens, toBlock: latest < fromBlock ? fromBlock - 1n : latest };
      },
    };
  }

  const ballots: BallotReader = createBallotReader(publicClient, eg);

  return { reader, writer, ballots, factoryLogs, publicClient };
}
