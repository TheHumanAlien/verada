/**
 * Private RPC: every chain read leaves the browser through an anon-rpc worker
 * (Nym or Tor, running sandboxed in a null-origin iframe), so the RPC provider
 * never sees the user's IP address and cannot link one account's queries to another's.
 *
 * Two scopes:
 *  - "public": data that is the same for everyone (token lists, epochs). If the
 *    anon network is down the user may explicitly allow a direct connection for these.
 *  - "account": anything keyed by the user's address (portfolio, donations made,
 *    votes made, simulations with `from`). These NEVER fall back to a direct
 *    connection. They fail closed.
 *
 * Every account gets its own random isolation key, so the anon network is asked
 * to keep different accounts' traffic unlinkable. Keys live in memory only and
 * are regenerated on every page load.
 */
import { fallback, http, type Address, type Transport } from "viem";
import type { AnonFetch, AnonRpcWorker, RpcProvider, WorkerInit } from "@anon-rpc/browser-harness";
import { ANON_NETWORKS } from "./anon-networks";
import type { PrivateRpcConfig } from "./config";

export type PrivateRpcStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "failed"; code?: string; message: string };

export type Scope = { kind: "public" } | { kind: "account"; address: Address };

export class PrivateRpcUnavailableError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PrivateRpcUnavailableError";
  }
}

export type WorkerLike = Pick<AnonRpcWorker, "ready" | "fetch" | "close">;
export type WorkerFactory = (init: WorkerInit) => Promise<WorkerLike>;

const defaultFactory: WorkerFactory = async (init) => {
  // Browser-only: the harness builds an iframe and a Web Worker. Loaded on first use.
  const { AnonRpcWorker } = await import("@anon-rpc/browser-harness");
  return new AnonRpcWorker(init);
};

/**
 * Measured on Nym (2026-11-05): ~8s to bootstrap, ~6s per request. Allow well over
 * viem's 10s default, and batch JSON-RPC calls so one mixnet round trip carries many.
 */
export const PRIVATE_RPC_TIMEOUT_MS = 45_000;

function randomKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Plain JSON-RPC provider for the one direct bootstrap read (the specifier's workerHash/resolvers). */
export function jsonRpcProvider(url: string, fetchImpl: typeof fetch): RpcProvider {
  let id = 0;
  return {
    async request({ method, params }) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        // Keep the one direct request free of cookies and referrer.
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? "bootstrap RPC error");
      return body.result;
    },
  };
}

export interface PrivateRpcOptions {
  factory?: WorkerFactory;
  /** Used only for the bootstrap read and for public-scope requests the user explicitly allowed. */
  directFetch?: typeof fetch;
}

export class PrivateRpc {
  private worker?: Promise<WorkerLike>;
  private status: PrivateRpcStatus = { state: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly accountKeys = new Map<string, string>();
  private readonly publicKey = randomKey();
  private directForPublic = false;
  private account?: Address;
  private readonly factory: WorkerFactory;
  private readonly directFetch: typeof fetch;

  constructor(
    readonly cfg: PrivateRpcConfig,
    opts: PrivateRpcOptions = {},
  ) {
    this.factory = opts.factory ?? defaultFactory;
    this.directFetch = opts.directFetch ?? ((...a) => fetch(...a));
  }

  get network() {
    return ANON_NETWORKS[this.cfg.network];
  }

  get specifier(): string {
    return this.cfg.specifier ?? this.network.specifier;
  }

  getStatus(): PrivateRpcStatus {
    return this.status;
  }

  /** True when the user has opted to send public (non-account) reads directly. */
  get directPublicAllowed(): boolean {
    return this.directForPublic;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(s: PrivateRpcStatus) {
    this.status = s;
    for (const l of this.listeners) l();
  }

  /** The connected wallet. Requests made without an explicit scope are isolated under it. */
  setAccount(address: Address | undefined) {
    this.account = address;
  }

  isolationKey(scope: Scope): string {
    if (scope.kind === "public") return this.publicKey;
    const k = scope.address.toLowerCase();
    let key = this.accountKeys.get(k);
    if (!key) this.accountKeys.set(k, (key = randomKey()));
    return key;
  }

  /** Scope for requests that may carry the connected account (wagmi reads, simulations). */
  currentScope(): Scope {
    return this.account ? { kind: "account", address: this.account } : { kind: "public" };
  }

  /** Start the worker if it isn't running. Safe to call repeatedly. */
  start(): Promise<WorkerLike> {
    if (this.worker) return this.worker;
    this.setStatus({ state: "connecting" });
    const bootstrapUrl = this.cfg.bootstrapRpcUrl ?? this.cfg.rpcUrls[0];
    const init: WorkerInit = {
      address: this.specifier,
      config: this.cfg.workerConfig as WorkerInit["config"],
      preExisting: bootstrapUrl ? { rpcProvider: jsonRpcProvider(bootstrapUrl, this.directFetch) } : undefined,
    };
    const p = this.factory(init).then(async (w) => {
      await w.ready;
      return w;
    });
    this.worker = p;
    p.then(
      () => this.worker === p && this.setStatus({ state: "ready" }),
      (e: unknown) => {
        if (this.worker !== p) return;
        const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined;
        this.setStatus({ state: "failed", code, message: e instanceof Error ? e.message : String(e) });
      },
    );
    return p;
  }

  /** Tear down and reconnect, e.g. after a failure. */
  retry(): Promise<WorkerLike> {
    this.close();
    return this.start();
  }

  /**
   * Opt in (for this page load only) to direct connections for public reads while
   * the anon network is unavailable. Account-scoped requests are never affected.
   */
  allowDirectForPublic(on: boolean) {
    this.directForPublic = on;
    for (const l of this.listeners) l();
  }

  close() {
    const w = this.worker;
    this.worker = undefined;
    void w?.then((x) => x.close()).catch(() => {});
    this.setStatus({ state: "idle" });
  }

  /** fetch through the anon network. Account scope fails closed; public scope honours the direct opt-in. */
  async fetch(input: string | URL | Request, init: RequestInit = {}, scope: Scope = { kind: "public" }): Promise<Response> {
    if (scope.kind === "public" && this.directForPublic && this.status.state !== "ready") {
      return this.directFetch(input, init);
    }
    let w: WorkerLike;
    try {
      w = await this.start();
    } catch (e) {
      throw new PrivateRpcUnavailableError(
        `Private RPC (${this.network.label}) is unavailable: ${e instanceof Error ? e.message : String(e)}`,
        this.status.state === "failed" ? this.status.code : undefined,
      );
    }
    return (w.fetch as AnonFetch)(input, { ...init, anonOptions: { isolationKey: this.isolationKey(scope) } });
  }

  /** A fetch bound to a scope, or to the connected account when `scope` is omitted. */
  fetchFor(scope?: Scope): typeof fetch {
    return (input, init) => {
      // viem adds its own `url` key to init; don't forward it to the worker.
      const rest: RequestInit & { url?: string } = { ...init };
      delete rest.url;
      return this.fetch(input as string | URL | Request, rest, scope ?? this.currentScope());
    };
  }

  /** viem transport over the private fetch, failing over across `rpcUrls` (all anonymized). */
  transport(scope?: Scope): Transport {
    const fetchFn = this.fetchFor(scope);
    const transports = this.cfg.rpcUrls.map((url) => http(url, { fetchFn, timeout: PRIVATE_RPC_TIMEOUT_MS, batch: { wait: 20 } }));
    if (transports.length === 0) throw new Error("privateRpc.rpcUrls is empty");
    return transports.length === 1 ? transports[0]! : fallback(transports);
  }
}
