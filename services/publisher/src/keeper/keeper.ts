import type { Address } from "viem";
import type { Log } from "../jobs/types.js";
import { Backoff } from "./backoff.js";
import { KeeperRevert, redact, type ChainReader, type ChainWriter, type KeeperAction } from "./chain.js";
import type { BallotPreparer } from "./ballot.js";
import { checkDecryption, type PublicDecryptor } from "./decrypt.js";
import { epochNeedsTally, planEpoch, planProposal, proposalNeedsTally, type Step } from "./plan.js";

export interface KeeperDeps {
  reader: ChainReader;
  writer: ChainWriter;
  decryptor: PublicDecryptor;
  /** Prepares current-epoch ballots that need rotation draws; omitted when no catalogue source. */
  ballots?: BallotPreparer;
  /** Tokens to keep (indexer listing with a factory-log fallback). */
  tokens: () => Promise<Address[]>;
  epochGovernor: Address;
  takeoverGovernor: Address;
  /** The Zama voting scheme; polls on any other scheme are never decrypted. */
  zamaScheme: Address;
  dryRun: boolean;
  maxTxPerRun: number;
  lookbackEpochs: number;
  log: Log;
  backoff?: Backoff;
  /** Steps taken for one epoch or proposal per run (close, decrypt+submit, finalize). */
  maxStepsPerItem?: number;
  /** Gas limit = estimate * gasBufferPct / 100. */
  gasBufferPct?: bigint;
  /**
   * Indexer facts on which tokens are active. With it, the keeper opens the current epoch only for
   * active tokens (see {@link idleEpochs}); without it, or when it fails, every epoch is opened.
   */
  activity?: ActivitySource;
  /**
   * A token is idle, and its current epoch is left closed for anyone to open on demand, when the
   * indexer shows no fees credited to its pools and no ballots in the last `idleEpochs` epochs
   * (and the current one), no pin change and no launch since the start of epoch
   * `current - idleEpochs`. 0 opens every epoch. Default 2.
   */
  idleEpochs?: number;
}

/** Tokens with recent activity (indexer `/api/active-tokens`). */
export interface ActivitySource {
  activeTokens(sinceEpoch: bigint, sinceTime: bigint): Promise<{ token: string }[]>;
}

export interface KeeperRunSummary {
  tokens: number;
  epochsChecked: number;
  ballotsChecked: number;
  /** Current-epoch openings skipped because the token is idle. */
  idleSkipped: number;
  proposalsChecked: number;
  /** Transactions mined (or, in dry run, planned). */
  txs: number;
  decrypted: number;
  failed: number;
  backedOff: number;
  capped: boolean;
  halted: boolean;
  dryRun: boolean;
}

type ItemRef = { token: Address; epoch: bigint } | { proposal: bigint; token?: Address };

const describe = (a: KeeperAction): Record<string, unknown> => {
  switch (a.kind) {
    case "openEpoch":
    case "closeEpoch":
    case "finalizeEpoch":
      return { tx: a.kind, token: a.token, epoch: a.epoch };
    case "submitTally":
      return { tx: a.kind, token: a.token, scope: a.scope, governor: a.governor };
    case "prepareBallot":
      return { tx: a.kind, token: a.token, epoch: a.epoch, draws: a.draws.length };
    case "prepareCuratedBallot":
      return { tx: a.kind, token: a.token, epoch: a.epoch, curated: a.curated.length, draws: a.draws.length };
    default:
      return { tx: a.kind, proposal: a.id };
  }
};

/**
 * The tally keeper. Every decision is read from chain state at run time, so runs are idempotent and
 * a restart loses nothing but backoff timers. Transactions go out one at a time from one account,
 * each after a gas estimate and followed by its receipt, so the nonce sequence never forks.
 */
export function createKeeper(deps: KeeperDeps) {
  const backoff = deps.backoff ?? new Backoff();
  const maxSteps = deps.maxStepsPerItem ?? 4;
  const buffer = deps.gasBufferPct ?? 120n;
  /** Epochs already finalized and proposals in a terminal state: never read again. */
  const doneEpochs = new Map<string, bigint>();
  const doneProposals = new Set<bigint>();
  /** Current-epoch ballots that are prepared or need no keeper help. */
  const doneBallots = new Set<string>();
  /** Current-epoch ballots already logged as skipped (one line per token and epoch, not per run). */
  const idleLogged = new Set<string>();
  const idleEpochs = deps.idleEpochs ?? 2;

  /** Lowercase addresses of active tokens, or null when every epoch should be opened. */
  async function activeSet(current: bigint): Promise<Set<string> | null> {
    if (!deps.activity || idleEpochs <= 0) return null;
    const since = current > BigInt(idleEpochs) ? current - BigInt(idleEpochs) : 0n;
    try {
      const sinceTime = await deps.reader.epochStart(since);
      const items = await deps.activity.activeTokens(since, sinceTime);
      return new Set(items.map((i) => i.token.toLowerCase()));
    } catch (err) {
      deps.log("warn", "keeper could not read token activity; opening every current epoch", {
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return null;
    }
  }

  async function run(): Promise<KeeperRunSummary> {
    const s: KeeperRunSummary = {
      tokens: 0,
      epochsChecked: 0,
      ballotsChecked: 0,
      idleSkipped: 0,
      proposalsChecked: 0,
      txs: 0,
      decrypted: 0,
      failed: 0,
      backedOff: 0,
      capped: false,
      halted: false,
      dryRun: deps.dryRun,
    };
    const stop = () => s.halted || s.capped;

    /**
     * Records a failed step and backs the item off. Logged at `error` (alarmed on by infra), except
     * `NoVotes`: an empty epoch with no default cause is an expected, owner-fixable state, so it stays
     * at `warn` and just waits out its backoff.
     */
    const fail = (key: string, ref: ItemRef, op: string, err: unknown) => {
      s.failed++;
      const hint = (err as { retryAt?: unknown } | null)?.retryAt;
      const retryAt = typeof hint === "number" ? hint : undefined;
      const delay = backoff.fail(key, retryAt);
      const data: Record<string, unknown> = { ...ref, op, retryInSeconds: Math.round(delay / 1000), failures: backoff.failures(key) };
      if (err instanceof KeeperRevert) data.revert = err.errorName ?? "unknown";
      else data.error = redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      const expected = err instanceof KeeperRevert && err.errorName === "NoVotes";
      deps.log(expected ? "warn" : "error", "keeper step failed", data);
    };

    /** Builds `submitTally` from the scheme's handles and a public decryption. */
    const decryptAction = async (step: Extract<Step, { type: "decrypt" }>, ref: ItemRef): Promise<KeeperAction> => {
      const handles = await deps.reader.tallyHandles(step.scheme, step.governor, step.token, step.scope);
      if (handles.length === 0) throw new Error("poll has no tally handles");
      const r = await deps.decryptor.publicDecrypt(handles);
      const { cleartexts } = checkDecryption(handles, r);
      s.decrypted++;
      deps.log("info", "tally decrypted", { ...ref, options: handles.length });
      return { kind: "submitTally", scheme: step.scheme, governor: step.governor, token: step.token, scope: step.scope, cleartexts, proof: r.decryptionProof };
    };

    /** Drives one item through up to `maxSteps` steps, re-reading chain state before each. */
    const drive = async (key: string, ref: ItemRef, next: () => Promise<Step>): Promise<"done" | "open"> => {
      if (backoff.blocked(key)) {
        s.backedOff++;
        return "open";
      }
      for (let i = 0; i < maxSteps && !stop(); i++) {
        let step: Step;
        try {
          step = await next();
        } catch (err) {
          fail(key, ref, "read", err);
          return "open";
        }
        if (step.type === "none") return step.terminal ? "done" : "open";
        if (s.txs >= deps.maxTxPerRun) {
          s.capped = true;
          return "open";
        }

        if (step.type === "decrypt" && deps.dryRun) {
          s.txs++;
          deps.log("info", "keeper dry run", { ...ref, tx: "submitTally", note: "decryption skipped in dry run" });
          return "open";
        }
        let action: KeeperAction;
        try {
          action = step.type === "decrypt" ? await decryptAction(step, ref) : step.action;
        } catch (err) {
          fail(key, ref, "decrypt", err);
          return "open";
        }

        let gas: bigint;
        try {
          gas = await deps.writer.estimate(action);
        } catch (err) {
          fail(key, ref, action.kind, err);
          return "open";
        }
        if (deps.dryRun) {
          s.txs++;
          deps.log("info", "keeper dry run", { ...describe(action), gasEstimate: gas });
          return "open";
        }

        const limit = (gas * buffer) / 100n;
        try {
          s.txs++;
          const r = await deps.writer.send(action, limit);
          if (r.status !== "success") {
            fail(key, ref, action.kind, new Error(`transaction ${r.hash} reverted`));
            return "open";
          }
          deps.log("info", "keeper tx mined", { ...describe(action), hash: r.hash, gasUsed: r.gasUsed });
          backoff.clear(key);
        } catch (err) {
          // A send or receipt failure may leave a pending nonce: stop the run rather than stack more.
          fail(key, ref, action.kind, err);
          s.halted = true;
          return "open";
        }
      }
      return "open";
    };

    // Takeovers first: their execution window is the tighter deadline.
    let count = 0n;
    try {
      count = await deps.reader.proposalCount();
    } catch (err) {
      deps.log("error", "keeper could not read proposal count", { error: redact(err instanceof Error ? err.message : String(err)) });
    }
    for (let id = 1n; id <= count && !stop(); id++) {
      if (doneProposals.has(id)) continue;
      s.proposalsChecked++;
      const ref: ItemRef = { proposal: id };
      const r = await drive(`proposal:${id}`, ref, async () => {
        const p = await deps.reader.proposal(id);
        const tally = proposalNeedsTally(p) ? await deps.reader.tallyOf(p.scheme, deps.takeoverGovernor, p.token, id) : undefined;
        return planProposal(id, p, tally, deps);
      });
      if (r === "done") doneProposals.add(id);
    }

    if (!stop()) {
      const current = await deps.reader.currentEpoch();
      const from = current > BigInt(deps.lookbackEpochs) ? current - BigInt(deps.lookbackEpochs) : 0n;
      for (const [k, e] of doneEpochs) if (e < from) doneEpochs.delete(k);
      const tokens = await deps.tokens();
      s.tokens = tokens.length;

      for (const k of doneBallots) if (!k.endsWith(`:${current}`)) doneBallots.delete(k);
      for (const k of idleLogged) if (!k.endsWith(`:${current}`)) idleLogged.delete(k);
      const active = deps.ballots ? await activeSet(current) : null;

      for (const token of tokens) {
        if (stop()) break;
        // The current epoch's ballot first: nobody can vote until the epoch is opened.
        const ballotKey = `ballot:${token.toLowerCase()}:${current}`;
        if (deps.ballots && !doneBallots.has(ballotKey) && active && !active.has(token.toLowerCase())) {
          // Idle: re-checked every run, so the epoch opens once fees, ballots or pins show up.
          s.idleSkipped++;
          if (!idleLogged.has(ballotKey)) {
            idleLogged.add(ballotKey);
            deps.log("info", "keeper skipped idle epoch", { token, epoch: current, idleEpochs });
          }
        } else if (deps.ballots && !doneBallots.has(ballotKey)) {
          s.ballotsChecked++;
          const ballots = deps.ballots;
          const r = await drive(ballotKey, { token, epoch: current }, async () => {
            if (!(await deps.reader.isRegistered(token))) return { type: "none", reason: "not registered", terminal: true };
            return ballots.plan(token, current);
          });
          if (r === "done") doneBallots.add(ballotKey);
        }
        const pending: bigint[] = [];
        for (let e = from; e < current; e++) if (!doneEpochs.has(`epoch:${token.toLowerCase()}:${e}`)) pending.push(e);
        if (pending.length === 0) continue;
        let registered: boolean;
        try {
          registered = await deps.reader.isRegistered(token);
        } catch (err) {
          deps.log("warn", "keeper could not read token registration", { token, error: redact(err instanceof Error ? err.message : String(err)) });
          continue;
        }
        if (!registered) continue;

        for (const epoch of pending) {
          if (stop()) break;
          s.epochsChecked++;
          const key = `epoch:${token.toLowerCase()}:${epoch}`;
          const r = await drive(key, { token, epoch }, async () => {
            const v = await deps.reader.epoch(token, epoch);
            const tally = epochNeedsTally(v) ? await deps.reader.tallyOf(v.scheme, deps.epochGovernor, token, epoch) : undefined;
            return planEpoch(token, epoch, v, tally, { epochGovernor: deps.epochGovernor, zamaScheme: deps.zamaScheme });
          });
          if (r === "done") doneEpochs.set(key, epoch);
        }
      }
    }
    if (s.capped) deps.log("warn", "keeper reached its per-run transaction cap", { maxTxPerRun: deps.maxTxPerRun });
    return s;
  }

  return { run, backoff };
}
