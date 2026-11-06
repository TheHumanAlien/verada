import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import {
  KeeperRevert,
  type ChainReader,
  type ChainWriter,
  type EpochView,
  type KeeperAction,
  type ProposalState,
  type ProposalView,
} from "../src/keeper/chain.js";
import { createFakeDecryptor, decodeCleartexts } from "../src/keeper/decrypt.js";

export const EG = "0x00000000000000000000000000000000000000e1" as Address;
export const TG = "0x00000000000000000000000000000000000000e2" as Address;
export const ZAMA = "0x00000000000000000000000000000000000000a1" as Address;
export const OTHER_SCHEME = "0x00000000000000000000000000000000000000b2" as Address;
export const KEEPER = "0x000000000000000000000000000000000000c0de" as Address;
export const PROOF = "0x5eed" as Hex;
export const token = (i: number) => getAddress(`0x${(0xaa00 + i).toString(16).padStart(40, "0")}`);

interface Poll {
  handles: Hex[];
  values: bigint[];
  closed: boolean;
  isFinal: boolean;
  counts: bigint[];
}
interface EpochState {
  opened: boolean;
  closed: boolean;
  finalized: boolean;
  voters: bigint;
  scheme: Address;
}
interface Proposal {
  token: Address;
  ended: boolean;
  expired: boolean;
  closed: boolean;
  tallied: boolean;
  executed: boolean;
  canceled: boolean;
  quorum: bigint;
  forWeight: bigint;
  againstWeight: bigint;
  scheme: Address;
}

const pollKey = (governor: Address, t: Address, scope: bigint) => `${governor}:${t}:${scope}`.toLowerCase();
const revert = (name: string) => new KeeperRevert(name, `would revert ${name}`);

/** In-memory EpochGovernor + TakeoverGovernor + ZamaVotingScheme with the contracts' guards. */
export class FakeChain {
  current = 10n;
  registered = new Set<string>();
  defaultCause = true;
  epochs = new Map<string, EpochState>();
  polls = new Map<string, Poll>();
  proposals: Proposal[] = [];
  sent: KeeperAction[] = [];
  /** `token:epoch` of prepared ballots. */
  prepared = new Set<string>();
  estimates: KeeperAction[] = [];
  reads = 0;
  sendError?: Error;
  private handleSeq = 0;

  register(t: Address) {
    this.registered.add(t.toLowerCase());
    return this;
  }

  private epochState(t: Address, e: bigint): EpochState {
    const k = `${t}:${e}`.toLowerCase();
    let s = this.epochs.get(k);
    if (!s) {
      s = { opened: false, closed: false, finalized: false, voters: 0n, scheme: "0x0000000000000000000000000000000000000000" };
      this.epochs.set(k, s);
    }
    return s;
  }

  private openPoll(governor: Address, t: Address, scope: bigint, values: bigint[]) {
    const handles = values.map(() => keccak256(toHex(`handle-${++this.handleSeq}`)));
    this.polls.set(pollKey(governor, t, scope), { handles, values, closed: false, isFinal: false, counts: [] });
  }

  /** Opens an epoch with ballots whose (hidden) per-option totals are `values`. */
  openEpoch(t: Address, e: bigint, voters: bigint, values: bigint[] = [0n, 0n], scheme: Address = ZAMA) {
    Object.assign(this.epochState(t, e), { opened: true, voters, scheme });
    this.openPoll(EG, t, e, values);
  }

  epochOf(t: Address, e: bigint) {
    return this.epochState(t, e);
  }

  pollOf(governor: Address, t: Address, scope: bigint) {
    return this.polls.get(pollKey(governor, t, scope));
  }

  addProposal(p: Partial<Proposal> & { token: Address }, values: bigint[] = [0n, 0n]): bigint {
    this.proposals.push({
      ended: true, expired: false, closed: false, tallied: false, executed: false, canceled: false,
      quorum: 10n, forWeight: 0n, againstWeight: 0n, scheme: ZAMA, ...p,
    });
    const id = BigInt(this.proposals.length);
    this.openPoll(TG, p.token, id, values);
    return id;
  }

  stateOf(id: bigint): ProposalState {
    const p = this.proposals[Number(id) - 1];
    if (!p) return "None";
    if (p.canceled) return "Canceled";
    if (p.executed) return "Executed";
    if (p.tallied) {
      if (!(p.forWeight >= p.quorum && p.forWeight > p.againstWeight)) return "Defeated";
      return p.expired ? "Expired" : "Succeeded";
    }
    if (!p.ended && !p.closed) return "Active";
    if (p.expired) return "Expired";
    return "Closing";
  }

  reader(): ChainReader {
    const r = <T>(v: T) => {
      this.reads++;
      return Promise.resolve(v);
    };
    return {
      currentEpoch: () => r(this.current),
      isRegistered: (t) => r(this.registered.has(t.toLowerCase())),
      epoch: (t, e) => {
        const s = this.epochState(t, e);
        const v: EpochView = { opened: s.opened, closed: s.closed, finalized: s.finalized, voterCount: s.voters, scheme: s.scheme };
        return r(v);
      },
      tallyOf: (scheme, governor, t, scope) => {
        const p = this.polls.get(pollKey(governor, t, scope));
        return r({ isFinal: p?.isFinal ?? false, counts: p?.counts ?? [] });
      },
      tallyHandles: (scheme, governor, t, scope) => r(this.polls.get(pollKey(governor, t, scope))?.handles ?? []),
      proposalCount: () => r(BigInt(this.proposals.length)),
      proposal: (id) => {
        const p = this.proposals[Number(id) - 1]!;
        const v: ProposalView = { token: p.token, state: this.stateOf(id), closed: p.closed, tallied: p.tallied, scheme: p.scheme };
        return r(v);
      },
    };
  }

  /** Validates `a` like the contracts would and applies it unless `dry`. */
  private apply(a: KeeperAction, dry: boolean) {
    switch (a.kind) {
      case "closeEpoch": {
        if (a.epoch >= this.current) throw revert("EpochNotEnded");
        const s = this.epochState(a.token, a.epoch);
        if (!s.opened) throw revert("EpochNotOpened");
        if (s.closed) throw revert("EpochAlreadyClosed");
        if (!dry) {
          s.closed = true;
          this.polls.get(pollKey(EG, a.token, a.epoch))!.closed = true;
        }
        return;
      }
      case "finalizeEpoch": {
        if (a.epoch >= this.current) throw revert("EpochNotEnded");
        const s = this.epochState(a.token, a.epoch);
        if (s.finalized) throw revert("EpochAlreadyFinalized");
        let best = 0n;
        if (s.opened && s.voters > 0n) {
          const p = this.polls.get(pollKey(EG, a.token, a.epoch))!;
          if (!p.isFinal) throw revert("TallyNotFinal");
          for (const c of p.counts) if (c > best) best = c;
        }
        if (best === 0n && !this.defaultCause) throw revert("NoVotes");
        if (!dry) s.finalized = true;
        return;
      }
      case "submitTally": {
        const p = this.polls.get(pollKey(a.governor, a.token, a.scope));
        if (!p?.closed) throw revert("PollNotClosed");
        if (p.isFinal) throw revert("TallyAlreadyFinal");
        if ((a.cleartexts.length - 2) / 2 !== 32 * p.handles.length) throw revert("InvalidTallyProof");
        const words = decodeCleartexts(a.cleartexts);
        // Stands in for FHE.checkSignatures: the proof must match and the words must be the true totals in handle order.
        if (a.proof !== PROOF || words.some((w, i) => w !== p.values[i])) throw revert("InvalidKMSSignatures");
        if (!dry) {
          p.isFinal = true;
          p.counts = words;
        }
        return;
      }
      case "closeProposal": {
        const s = this.stateOf(a.id);
        const p = this.proposals[Number(a.id) - 1]!;
        if (s === "Active") throw revert("VotingNotEnded");
        if (p.closed) throw revert("AlreadyClosed");
        if (s !== "Closing") throw revert("NotClosable");
        if (!dry) {
          p.closed = true;
          this.polls.get(pollKey(TG, p.token, a.id))!.closed = true;
        }
        return;
      }
      case "recordTally": {
        const p = this.proposals[Number(a.id) - 1]!;
        if (!p.closed) throw revert("NotClosed");
        if (p.tallied) throw revert("AlreadyTallied");
        const poll = this.polls.get(pollKey(TG, p.token, a.id))!;
        if (!poll.isFinal) throw revert("TallyNotFinal");
        if (!dry) {
          p.againstWeight = poll.counts[0]!;
          p.forWeight = poll.counts[1]!;
          p.tallied = true;
        }
        return;
      }
      case "openEpoch":
      case "prepareBallot":
      case "prepareCuratedBallot": {
        // Both prepare the ballot and open the epoch; the contract rejects ballots before that.
        if (a.epoch !== this.current) throw revert("EpochNotCurrent");
        const k = `${a.token}:${a.epoch}`.toLowerCase();
        if (this.prepared.has(k)) throw revert("BallotAlreadyPrepared");
        if (!dry) {
          this.prepared.add(k);
          Object.assign(this.epochState(a.token, a.epoch), { opened: true, scheme: ZAMA });
        }
        return;
      }
      case "execute": {
        if (this.stateOf(a.id) !== "Succeeded") throw revert("NotExecutable");
        if (!dry) this.proposals[Number(a.id) - 1]!.executed = true;
        return;
      }
    }
  }

  writer(): ChainWriter {
    return {
      account: KEEPER,
      estimate: async (a) => {
        this.estimates.push(a);
        this.apply(a, true);
        return 100_000n;
      },
      send: async (a, gas) => {
        if (gas < 100_000n) throw new Error("gas limit below estimate");
        if (this.sendError) throw this.sendError;
        this.apply(a, false);
        this.sent.push(a);
        return { hash: keccak256(toHex(`tx-${this.sent.length}`)), status: "success" as const, gasUsed: 90_000n };
      },
    };
  }

  /** Decryptor that knows the true totals behind every handle. */
  decryptor(opts: Parameters<typeof createFakeDecryptor>[1] = {}) {
    return createFakeDecryptor(
      (h) => {
        for (const p of this.polls.values()) {
          const i = p.handles.findIndex((x) => x.toLowerCase() === h.toLowerCase());
          if (i >= 0) return p.values[i]!;
        }
        throw new Error("unknown handle");
      },
      { proof: PROOF, ...opts },
    );
  }
}

export const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => {
    logs.push({ level, msg, data });
  };
  return { logs, log };
};
