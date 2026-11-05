/**
 * In-memory stand-in for the Arkiv clients, for tests. It honours the rules the registry relies
 * on: `$creator` is immutable, readonly entities reject patches, only the owner may patch or hand
 * an entity on (and never to the zero address), and only the owner may extend unless the entity
 * was created with `permissionlessExtension`. Queries filter by schema tag, creator and
 * `$key > x`, sort by `$key` and honour `limit`.
 */
import { encodePacked, keccak256, zeroAddress, type Address, type Hex } from "viem";
import type { RegistryPublicClient, RegistryWalletClient } from "./client.js";

type Tagged = { type: string; value: unknown };

export interface FakeEntity {
  key: Hex;
  schema: string;
  owner: Address;
  creator: Address;
  expiresAt: bigint;
  readonly: boolean;
  permissionlessExtension: boolean;
  attrs: Record<string, Tagged>;
}

export interface FakeArkivOptions {
  account?: Address;
  currentBlock?: bigint;
  /** Blocks an `ExpirationTime` resolves to (the fake ignores the value it is given). */
  lifetimeBlocks?: bigint;
}

const lower = (s: string) => s.toLowerCase();

function findKeyFloor(expr: unknown): Hex | undefined {
  if (!expr || typeof expr !== "object") return undefined;
  const e = expr as Record<string, unknown>;
  if (e.kind === "comparison" && e.name === "$key" && e.operator === ">") {
    return (e.value as Tagged).value as Hex;
  }
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) {
      for (const x of v) {
        const k = findKeyFloor(x);
        if (k) return k;
      }
    } else if (v && typeof v === "object") {
      const k = findKeyFloor(v);
      if (k) return k;
    }
  }
  return undefined;
}

export class FakeArkiv {
  readonly entities = new Map<Hex, FakeEntity>();
  readonly calls: { method: string; args: unknown }[] = [];
  account: Address;
  currentBlock: bigint;
  lifetimeBlocks: bigint;
  /** Per-owner entity nonce, as the engine keeps it. */
  private nonces = new Map<string, bigint>();
  /** Throw from the next write whose method matches. */
  failNext: string | null = null;

  constructor(opts: FakeArkivOptions = {}) {
    this.account = opts.account ?? "0x1111111111111111111111111111111111111111";
    this.currentBlock = opts.currentBlock ?? 1_000n;
    this.lifetimeBlocks = opts.lifetimeBlocks ?? 7_884_000n;
  }

  private mint(owner: Address, salt: bigint): Hex {
    const n = this.nonces.get(lower(owner)) ?? 0n;
    this.nonces.set(lower(owner), n + 1n);
    return lower(keccak256(encodePacked(["address", "uint64", "uint128"], [owner, n, salt]))) as Hex;
  }

  private predict(owner: Address, index: number, salt: bigint): Hex {
    const n = (this.nonces.get(lower(owner)) ?? 0n) + BigInt(index);
    return lower(keccak256(encodePacked(["address", "uint64", "uint128"], [owner, n, salt]))) as Hex;
  }

  /** Inserts an entity directly, e.g. one written by another account. */
  seed(e: Omit<FakeEntity, "key"> & { key?: Hex }): Hex {
    const k = e.key ?? this.mint(e.creator, BigInt(this.entities.size + 1));
    this.entities.set(k, { ...e, key: k });
    return k;
  }

  private txHash(): Hex {
    return keccak256(encodePacked(["uint256"], [BigInt(this.calls.length)]));
  }

  private checkFail(method: string) {
    if (this.failNext && this.failNext === method) {
      this.failNext = null;
      throw new Error(`fake ${method} failed`);
    }
  }

  private row(e: FakeEntity) {
    return {
      $key: e.key,
      $owner: e.owner,
      $creator: e.creator,
      $expiresAt: e.expiresAt,
      $createdAt: 0n,
      $updatedAt: 0n,
      $creationFlags: { readonly: e.readonly, permissionlessExtension: e.permissionlessExtension, raw: 0 },
      ...e.attrs,
    };
  }

  get publicClient(): RegistryPublicClient {
    const self = this;
    const client = {
      select() {
        const state: { schema?: string; creator?: string; owner?: string; after?: Hex; limit: number } = { limit: 100 };
        const b = {
          from(schema: { name: string }) {
            state.schema = schema.name;
            return b;
          },
          createdBy(a: string) {
            state.creator = lower(a);
            return b;
          },
          ownedBy(a: string) {
            state.owner = lower(a);
            return b;
          },
          where(...exprs: unknown[]) {
            const k = findKeyFloor(exprs);
            if (k) state.after = lower(k) as Hex;
            return b;
          },
          orderBy() {
            return b;
          },
          limit(n: number) {
            state.limit = n;
            return b;
          },
          async fetch() {
            self.calls.push({ method: "query", args: { ...state } });
            const rows = [...self.entities.values()]
              .filter((e) => e.expiresAt > self.currentBlock)
              .filter((e) => !state.schema || e.schema === state.schema)
              .filter((e) => !state.creator || lower(e.creator) === state.creator)
              .filter((e) => !state.owner || lower(e.owner) === state.owner)
              .filter((e) => !state.after || e.key > state.after)
              .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
              .slice(0, state.limit)
              .map((e) => self.row(e));
            return { entities: rows, blockNumber: self.currentBlock, skipped: 0, count: undefined };
          },
        };
        return b;
      },
      async getBlockTiming() {
        return { currentBlock: self.currentBlock, currentBlockTime: 0, blockDuration: 2 };
      },
      async predictEntityKeys({ owner, count }: { owner: Address; count: number }) {
        return Array.from({ length: count }, (_, i) => {
          const salt = BigInt(1000 + self.entities.size * 10 + i);
          return { key: self.predict(owner, i, salt), salt };
        });
      },
    };
    return client as unknown as RegistryPublicClient;
  }

  get walletClient(): RegistryWalletClient {
    const self = this;
    const client = {
      account: { address: self.account },
      async executeBatch(data: {
        creates?: { schema: { name: string }; values: Record<string, Tagged>; flags?: { readonly?: boolean; permissionlessExtension?: boolean }; salt?: bigint }[];
        patches?: { schema: { name: string }; entityKey: Hex; set?: Record<string, Tagged>; unset?: string[] }[];
        extensions?: { entityKey: Hex }[];
        ownershipChanges?: { entityKey: Hex; newOwner: Address }[];
        deletes?: { entityKey: Hex }[];
      }) {
        self.calls.push({ method: "executeBatch", args: data });
        self.checkFail("executeBatch");
        const total =
          (data.creates?.length ?? 0) + (data.patches?.length ?? 0) + (data.extensions?.length ?? 0) +
          (data.ownershipChanges?.length ?? 0) + (data.deletes?.length ?? 0);
        if (total === 0) throw new Error("executeBatch: empty batch");
        // Validate everything first: a batch applies whole or not at all.
        const next = new Map(self.entities);
        const createdEntities: Hex[] = [];
        for (const c of data.creates ?? []) {
          const k = self.mint(self.account, c.salt ?? BigInt(Math.floor(Math.random() * 1e9)));
          const attrs: Record<string, Tagged> = {};
          for (const [n, v] of Object.entries(c.values)) if (v !== undefined) attrs[n] = v;
          next.set(k, {
            key: k,
            schema: c.schema.name,
            owner: self.account,
            creator: self.account,
            expiresAt: self.currentBlock + self.lifetimeBlocks,
            readonly: c.flags?.readonly ?? false,
            permissionlessExtension: c.flags?.permissionlessExtension ?? false,
            attrs,
          });
          createdEntities.push(k);
        }
        for (const p of data.patches ?? []) self.applyPatch(next, p.entityKey, p.set, p.unset);
        for (const x of data.extensions ?? []) {
          const e = next.get(lower(x.entityKey) as Hex);
          if (!e) throw new Error("extend: no such entity");
          if (lower(e.owner) !== lower(self.account) && !e.permissionlessExtension) throw new Error("extend: not owner");
          next.set(e.key, { ...e, expiresAt: self.currentBlock + self.lifetimeBlocks });
        }
        for (const o of data.ownershipChanges ?? []) {
          const e = next.get(lower(o.entityKey) as Hex);
          if (!e) throw new Error("changeOwnership: no such entity");
          if (lower(e.owner) !== lower(self.account)) throw new Error("changeOwnership: not owner");
          if (lower(o.newOwner) === zeroAddress) throw new Error("changeOwnership: zero address");
          next.set(e.key, { ...e, owner: o.newOwner });
        }
        self.entities.clear();
        for (const [k, v] of next) self.entities.set(k, v);
        return {
          txHash: self.txHash(),
          createdEntities,
          patchedEntities: (data.patches ?? []).map((p) => p.entityKey),
          deletedEntities: [],
          extendedEntities: (data.extensions ?? []).map((e) => e.entityKey),
          ownershipChanges: (data.ownershipChanges ?? []).map((o) => o.entityKey),
        };
      },
      async patchEntity(_schema: { name: string }, entityKey: Hex, changes: { set?: Record<string, Tagged>; unset?: string[] }) {
        self.calls.push({ method: "patchEntity", args: { entityKey, changes } });
        self.checkFail("patchEntity");
        const next = new Map(self.entities);
        self.applyPatch(next, entityKey, changes.set, changes.unset);
        self.entities.clear();
        for (const [k, v] of next) self.entities.set(k, v);
        return { entityKey, txHash: self.txHash() };
      },
    };
    return client as unknown as RegistryWalletClient;
  }

  private applyPatch(m: Map<Hex, FakeEntity>, entityKey: Hex, set?: Record<string, Tagged>, unset?: string[]) {
    const e = m.get(lower(entityKey) as Hex);
    if (!e) throw new Error("patch: no such entity");
    if (e.readonly) throw new Error("patch: entity is readonly");
    if (lower(e.owner) !== lower(this.account)) throw new Error("patch: not owner");
    const attrs = { ...e.attrs };
    for (const [n, v] of Object.entries(set ?? {})) if (v !== undefined) attrs[n] = v;
    for (const n of unset ?? []) delete attrs[n];
    if (Object.keys(set ?? {}).length === 0 && (unset ?? []).length === 0) throw new Error("patch: empty");
    m.set(e.key, { ...e, attrs });
  }

  /** Entities of a schema, for assertions. */
  ofSchema(name: string): FakeEntity[] {
    return [...this.entities.values()].filter((e) => e.schema === name);
  }
}
