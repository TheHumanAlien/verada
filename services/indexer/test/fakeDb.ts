import type { Context } from "ponder:registry";

type Row = Record<string, unknown>;

// biome-ignore lint/suspicious/noExplicitAny: mirrors viem's readContract argument shape loosely
export type ReadContract = (args: { functionName: string; address: string; args?: readonly any[] }) => Promise<unknown>;

/**
 * Minimal in-memory stand-in for the Ponder store API; `pks` lists key columns per table.
 * `readContract` answers `context.client.readContract`; by default every read reverts.
 */
export function createFakeContext(pks: Map<object, string[]>, readContract?: ReadContract) {
  const client = {
    readContract:
      readContract ??
      (async () => {
        throw new Error("execution reverted");
      }),
  };
  const contracts = new Proxy({}, { get: () => ({ abi: [] }) });
  const tables = new Map<object, Map<string, Row>>();
  const store = (t: object) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t)!;
  };
  const keyOf = (t: object, row: Row) => (pks.get(t) ?? []).map((c) => String(row[c])).join("|");

  const db = {
    async find(t: object, key: Row) {
      return store(t).get(keyOf(t, key)) ?? null;
    },
    insert(t: object) {
      return {
        values(v: Row) {
          const k = keyOf(t, v);
          const p = (async () => {
            if (store(t).has(k)) throw new Error(`duplicate key ${k}`);
            store(t).set(k, { ...v });
          })();
          return Object.assign(p, {
            async onConflictDoNothing() {
              await p.catch(() => {});
            },
          });
        },
      };
    },
    update(t: object, key: Row) {
      return {
        async set(patch: Row | ((r: Row) => Row)) {
          const k = keyOf(t, key);
          const cur = store(t).get(k);
          if (!cur) throw new Error(`row not found ${k}`);
          store(t).set(k, { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) });
        },
      };
    },
  };
  return {
    context: { db, client, contracts } as unknown as Context<never>,
    client,
    rows: (t: object) => [...store(t).values()],
  };
}
