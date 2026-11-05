import { describe, expect, it, vi } from "vitest";
import { MAX_ATTRIBUTES } from "@arkiv-network/sdk/schema";
import {
  applyPlan,
  BURN_OWNER,
  Cause,
  createArkivRegistry,
  planHasWrites,
  planReconcile,
  toCause,
  toTokenCore,
  toProfileDraft,
  TokenCore,
  TokenProfile,
  IndexerCauseSchema,
  type RegistryLogger,
} from "../src/index.js";
import { FakeArkiv } from "../src/testing.js";
import { token } from "./fixtures.js";

const silent = (): RegistryLogger & { lines: string[] } => {
  const lines: string[] = [];
  const push = (msg: string, data?: Record<string, unknown>) => lines.push(`${msg} ${JSON.stringify(data ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return { lines, info: push, warn: push, error: push };
};

function setup(opts: { dryRun?: boolean; pageSize?: number; accessKey?: string } = {}) {
  const fake = new FakeArkiv();
  const logger = silent();
  const registry = createArkivRegistry({
    chain: "rabdi",
    accessKey: opts.accessKey,
    clients: { publicClient: fake.publicClient, walletClient: fake.walletClient },
    dryRun: opts.dryRun,
    pageSize: opts.pageSize,
    logger,
  });
  return { fake, registry, logger };
}

describe("schemas", () => {
  it("fit Arkiv's attribute limit (columns + the schema tag)", () => {
    for (const s of [TokenCore, TokenProfile, Cause]) {
      expect(Object.keys(s.columns).length + 1).toBeLessThanOrEqual(MAX_ATTRIBUTES);
    }
    expect(TokenCore.name).toBe("verada.token");
    expect(TokenProfile.name).toBe("verada.token-profile");
    expect(Cause.name).toBe("verada.cause");
  });
});

describe("createTokenRecords", () => {
  it("writes a readonly core, burns it, and links the profile to it", async () => {
    const { fake, registry } = setup();
    const t = token();
    const r = await registry.createTokenRecords(toTokenCore(t, 1), toProfileDraft(t, 1));
    expect(r.txHashes).toHaveLength(2);
    const [core] = fake.ofSchema("verada.token");
    const [profile] = fake.ofSchema("verada.token-profile");
    expect(core).toMatchObject({ key: r.coreKey, owner: BURN_OWNER, readonly: true, permissionlessExtension: true });
    expect(profile).toMatchObject({ key: r.profileKey, owner: fake.account, readonly: false, permissionlessExtension: true });
    expect(profile!.attrs.core).toEqual({ type: "key", value: r.coreKey });
    // Two batches: the create, then the ownership change.
    const batches = fake.calls.filter((c) => c.method === "executeBatch").map((c) => Object.keys(c.args as object));
    expect(batches).toEqual([["creates"], ["ownershipChanges"]]);
    // A burned readonly core cannot be patched by anyone, but anyone may extend it.
    await expect(fake.walletClient.patchEntity(TokenCore, r.coreKey!, { set: { label: "x" } })).rejects.toThrow();
    await expect(registry.extendExpiring([r.coreKey!])).resolves.toMatchObject({ txHashes: [expect.any(String)] });
  });

  it("reads back what it wrote", async () => {
    const { registry } = setup();
    const t = token({ textRecords: { description: "Ünïcode ✓", url: "https://a.org" } });
    await registry.createTokenRecords(toTokenCore(t, 1), toProfileDraft(t, 1));
    const [core] = await registry.listCores();
    const [profile] = await registry.listProfiles();
    expect(core!.values).toEqual(toTokenCore(t, 1));
    expect(profile!.values).toEqual({ ...toProfileDraft(t, 1), core: core!.key });
  });
});

describe("listing", () => {
  it("pages by $key and trusts only the platform's $creator", async () => {
    const { fake, registry } = setup({ pageSize: 2 });
    for (let i = 0; i < 5; i++) {
      const t = token();
      await registry.createTokenRecords(toTokenCore(t, 1), toProfileDraft(t, 1));
    }
    // A spoofed entity carrying our schema tag, written by someone else.
    fake.seed({
      schema: "verada.token",
      owner: "0x9999999999999999999999999999999999999999",
      creator: "0x9999999999999999999999999999999999999999",
      expiresAt: 10_000_000n,
      readonly: true,
      permissionlessExtension: false,
      attrs: {},
    });
    const cores = await registry.listCores();
    expect(cores).toHaveLength(5);
    expect(new Set(cores.map((c) => c.key)).size).toBe(5);
    const queries = fake.calls.filter((c) => c.method === "query" && (c.args as { schema: string }).schema === "verada.token");
    expect(queries).toHaveLength(3); // 2 + 2 + 1
    expect((queries[1]!.args as { after: string }).after).toBe([...cores].map((c) => c.key).sort()[1]);
    for (const q of queries) expect((q.args as { creator: string }).creator).toBe(fake.account.toLowerCase());
  });
});

describe("dry run", () => {
  it("logs the plan and sends nothing", async () => {
    const { fake, registry, logger } = setup({ dryRun: true });
    const t = token();
    const plan = planReconcile({ chainId: 1, indexerTokens: [t], existingCores: [], existingProfiles: [], currentBlock: 1n, renewBeforeBlocks: 1n });
    const summary = await applyPlan(registry, plan, { logger });
    expect(summary).toMatchObject({ dryRun: true, created: 1, failures: 0 });
    expect(fake.calls.filter((c) => c.method !== "query")).toEqual([]);
    expect(fake.entities.size).toBe(0);
    expect(logger.lines.join("\n")).toContain("dry-run: create token records");
  });
});

describe("applyPlan", () => {
  it("converges: a second plan after applying is empty", async () => {
    const { fake, registry } = setup();
    const tokens = [token(), token(), token()];
    const causes = [IndexerCauseSchema.parse({ causeId: `0x${"01".repeat(32)}`, payout: fake.account, active: true, name: "Food" })];
    const plan1 = planReconcile({
      chainId: 1,
      indexerTokens: tokens,
      indexerCauses: causes,
      existingCores: await registry.listCores(),
      existingProfiles: await registry.listProfiles(),
      existingCauses: await registry.listCauses(),
      currentBlock: await registry.currentBlock(),
      renewBeforeBlocks: 1_296_000n,
    });
    const s1 = await applyPlan(registry, plan1);
    expect(s1).toMatchObject({ created: 3, causesCreated: 1, failures: 0 });

    const changed = tokens.map((t, i) => (i === 0 ? { ...t, textRecords: { "com.twitter": "new" } } : t));
    const deactivated = [{ ...causes[0]!, active: false }];
    const read = async () => ({
      existingCores: await registry.listCores(),
      existingProfiles: await registry.listProfiles(),
      existingCauses: await registry.listCauses(),
      currentBlock: await registry.currentBlock(),
    });
    const plan2 = planReconcile({ chainId: 1, indexerTokens: changed, indexerCauses: deactivated, renewBeforeBlocks: 1_296_000n, ...(await read()) });
    expect(plan2.patches).toHaveLength(1);
    expect(plan2.patches[0]!.diff.unset.sort()).toEqual(["description", "website"]);
    expect(plan2.causePatches).toHaveLength(1);
    await applyPlan(registry, plan2);

    const plan3 = planReconcile({ chainId: 1, indexerTokens: changed, indexerCauses: deactivated, renewBeforeBlocks: 1_296_000n, ...(await read()) });
    expect(planHasWrites(plan3)).toBe(false);
    expect((await registry.listCauses())[0]!.values).toEqual(toCause(deactivated[0]!));
  });

  it("seals a core left unburned by an interrupted run", async () => {
    const { fake, registry } = setup();
    const t = token();
    // Fail the burn (second batch) only: let the first through.
    let n = 0;
    const real = fake.walletClient;
    const flaky = { ...real, account: real.account, executeBatch: (async (d: never) => (++n === 2 ? Promise.reject(new Error("rpc down")) : real.executeBatch(d))) as typeof real.executeBatch };
    const reg2 = createArkivRegistry({ chain: "rabdi", clients: { publicClient: fake.publicClient, walletClient: flaky }, logger: silent() });
    await expect(reg2.createTokenRecords(toTokenCore(t, 1), toProfileDraft(t, 1))).rejects.toThrow("rpc down");
    expect(fake.ofSchema("verada.token")[0]!.owner).toBe(fake.account);

    const plan = planReconcile({ chainId: 1, indexerTokens: [t], existingCores: await registry.listCores(), existingProfiles: await registry.listProfiles(), currentBlock: 1n, renewBeforeBlocks: 1n });
    expect(plan.burns).toHaveLength(1);
    expect(plan.creates).toHaveLength(0);
    await applyPlan(registry, plan);
    expect(fake.ofSchema("verada.token")[0]!.owner).toBe(BURN_OWNER);
  });

  it("continues past failures and redacts the access key", async () => {
    const accessKey = "secret-access-key-123";
    const { fake } = setup({ accessKey });
    const logger = silent();
    const real = fake.walletClient;
    const failing = {
      ...real,
      account: real.account,
      executeBatch: vi.fn(async () => {
        throw new Error(`HTTP request failed. URL: https://rpc.rabdi.db-chain.testnet.arkiv.network/${accessKey}`);
      }) as unknown as typeof real.executeBatch,
    };
    const reg = createArkivRegistry({ chain: "rabdi", accessKey, clients: { publicClient: fake.publicClient, walletClient: failing }, logger });
    const plan = planReconcile({ chainId: 1, indexerTokens: [token(), token()], existingCores: [], existingProfiles: [], currentBlock: 1n, renewBeforeBlocks: 1n });
    const s = await applyPlan(reg, plan, { logger });
    expect(s).toMatchObject({ created: 0, failures: 2 });
    expect(logger.lines.join("\n")).not.toContain(accessKey);
    expect(logger.lines.join("\n")).toContain("***");
  });

  it("extends in chunks", async () => {
    const { fake, registry } = setup();
    const keys = Array.from({ length: 70 }, (_, i) =>
      fake.seed({ schema: "verada.cause", owner: fake.account, creator: fake.account, expiresAt: 10n ** 9n, readonly: false, permissionlessExtension: false, attrs: {}, key: `0x${(i + 1).toString(16).padStart(64, "0")}` }),
    );
    const r = await registry.extendExpiring(keys);
    expect(r.txHashes).toHaveLength(3);
  });
});
