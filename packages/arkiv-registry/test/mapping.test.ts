import { describe, expect, it } from "vitest";
import { zeroAddress, type Hex } from "viem";
import {
  BURN_OWNER,
  diffCause,
  diffProfile,
  fitStr,
  IndexerCauseSchema,
  IndexerTokenSchema,
  normalizeLogoRef,
  parseItems,
  planHasWrites,
  planReconcile,
  SCHEMA_VERSION,
  toCause,
  toProfileDraft,
  toTokenCore,
  toTokenProfile,
  truncateStr,
  type StoredCore,
  type StoredProfile,
} from "../src/index.js";
import { LOGO, POOL, rawToken, token } from "./fixtures.js";

const PLATFORM = "0x1111111111111111111111111111111111111111";
const utf8 = (s: string) => new TextEncoder().encode(s).length;
const K = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;

describe("truncateStr", () => {
  it("leaves short strings alone", () => expect(truncateStr("hello")).toBe("hello"));
  it("cuts ASCII at the byte limit", () => expect(truncateStr("a".repeat(200))).toHaveLength(128));
  it("never splits a multi-byte code point", () => {
    const s = "é".repeat(100); // 2 bytes each
    const t = truncateStr(s);
    expect(utf8(t)).toBe(128);
    expect(t).toBe("é".repeat(64));
    const emoji = truncateStr("a" + "😀".repeat(40)); // 1 + 4n
    expect(utf8(emoji)).toBeLessThanOrEqual(128);
    expect(utf8(emoji)).toBe(125);
  });
  it("drops lone surrogates", () => expect(truncateStr("a\ud800b")).toBe("ab"));
  it("honours a custom limit", () => expect(truncateStr("abcdef", 3)).toBe("abc"));
});

describe("fitStr", () => {
  it("trims and rejects empty or oversize values instead of truncating", () => {
    expect(fitStr("  x ")).toBe("x");
    expect(fitStr("")).toBeUndefined();
    expect(fitStr(null)).toBeUndefined();
    expect(fitStr("https://x.org/" + "a".repeat(200))).toBeUndefined();
  });
});

describe("indexer schemas", () => {
  it("accepts the current token row (without the new fields)", () => {
    const raw = rawToken();
    for (const k of ["label", "logoRef", "textRecords"]) delete (raw as Record<string, unknown>)[k];
    const t = IndexerTokenSchema.parse(raw);
    expect(t.createdBlock).toBe(21000000n);
    expect(t.label).toBeUndefined();
    expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
  it("accepts the extended row and treats empty strings as absent", () => {
    const t = IndexerTokenSchema.parse(rawToken({ controller: "", editor: null, name: "Good", symbol: "GOOD" }));
    expect(t.controller).toBeUndefined();
    expect(t.editor).toBeUndefined();
    expect(t.symbol).toBe("GOOD");
  });
  it("parseItems keeps good rows and counts bad ones", () => {
    const r = parseItems(IndexerTokenSchema, [rawToken(), { address: "nope" }]);
    expect(r.ok).toHaveLength(1);
    expect(r.rejected).toBe(1);
  });
  it("causes need an org address or payout", () => {
    expect(IndexerCauseSchema.safeParse({ causeId: K(1), active: true }).success).toBe(false);
    expect(IndexerCauseSchema.safeParse({ causeId: K(1), active: true, payout: PLATFORM }).success).toBe(true);
  });
});

describe("toTokenCore", () => {
  it("maps launch facts", () => {
    const t = token();
    const c = toTokenCore(t, 1);
    expect(c).toMatchObject({
      token: t.address,
      chainId: 1n,
      poolId: POOL,
      launchBlock: 21000000n,
      label: t.label,
      metadataUri: `bzz://${LOGO}`,
      logoRef: LOGO,
      causeCategory: "",
      version: SCHEMA_VERSION,
    });
  });
  it("records the cause focus as glob-friendly slug lists and raw masks", () => {
    const c = toTokenCore(token({ categoryMask: 12n, regionMask: 3 }), 1);
    expect(c).toMatchObject({
      causeCategory: ",hunger,children-youth,",
      causeRegion: ",africa,asia,",
      categoryMask: 12n,
      regionMask: 3,
      version: 2,
    });
    const any = toTokenCore(token({ categoryMask: (1n << 64n) - 1n, regionMask: 0xffff }), 1);
    expect(any.causeCategory).toBe("*");
    expect(any.causeRegion).toBe("*");
    const none = toTokenCore(token(), 1);
    expect(none).toMatchObject({ causeCategory: "", causeRegion: "", categoryMask: 0n, regionMask: 0 });
  });
  it("blanks an invalid label and a zero logo", () => {
    const c = toTokenCore(token({ label: "Bad Label", logoRef: `0x${"0".repeat(64)}` }), 1);
    expect(c.label).toBe("");
    expect(c.logoRef).toBe("");
  });
  it("normalizes logo references in any accepted form", () => {
    expect(normalizeLogoRef(`bzz://${LOGO.toUpperCase()}`)).toBe(LOGO);
    expect(normalizeLogoRef(LOGO)).toBe(LOGO);
    expect(normalizeLogoRef("xyz")).toBeUndefined();
    expect(normalizeLogoRef("b".repeat(128))).toBeUndefined(); // encrypted refs never published
  });
});

describe("toProfileDraft / toTokenProfile", () => {
  it("maps ENS text records and defaults controller/editor", () => {
    const t = token({ textRecords: { url: "https://a.org", "org.telegram": "tg", "com.discord": "dc", description: "  hi  " } });
    const p = toTokenProfile(t, K(9), 1);
    expect(p).toMatchObject({
      core: K(9),
      controller: t.creator,
      editor: zeroAddress,
      website: "https://a.org",
      telegram: "tg",
      discord: "dc",
      description: "hi",
      logoRef: LOGO,
      updatedAtBlock: 21000000n,
    });
    expect("twitter" in p).toBe(false);
  });
  it("prefers explicit controller, editor, contenthash and update block", () => {
    const t = token({
      controller: "0x4444444444444444444444444444444444444444",
      editor: "0x5555555555555555555555555555555555555555",
      contenthash: `0xE40101FA011B20${LOGO}`,
      updatedAtBlock: "21000500",
    });
    const p = toProfileDraft(t, 1);
    expect(p.controller).toBe("0x4444444444444444444444444444444444444444");
    expect(p.editor).toBe("0x5555555555555555555555555555555555555555");
    expect(p.contenthash).toBe(`0xe40101fa011b20${LOGO}`);
    expect(p.updatedAtBlock).toBe(21000500n);
  });
  it("caps the description at 8 KiB", () => {
    const p = toProfileDraft(token({ textRecords: { description: "x".repeat(20_000) } }), 1);
    expect(utf8(p.description!)).toBe(8192);
  });
});

describe("toCause", () => {
  it("maps cause rows", () => {
    const c = toCause(IndexerCauseSchema.parse({ causeId: K(1).toUpperCase().replace("0X", "0x"), payout: PLATFORM, active: true, ein: "12-3456789", name: "Food Bank" }));
    expect(c).toEqual({ causeId: K(1), orgId: "", orgAddress: PLATFORM, name: "Food Bank", ein: "12-3456789", active: true });
  });
});

describe("diffProfile", () => {
  const base = toTokenProfile(token(), K(1), 1);
  it("is null when nothing changed", () => expect(diffProfile(base, { ...base })).toBeNull());
  it("ignores a lone updatedAtBlock change and address case", () => {
    expect(diffProfile(base, { ...base, updatedAtBlock: 99n, controller: base.controller.toLowerCase() as Hex })).toBeNull();
  });
  it("sets changed fields with the new update block and unsets removed ones", () => {
    const { website: _w, ...rest } = base;
    const d = diffProfile(base, { ...rest, twitter: "new", updatedAtBlock: 5n });
    expect(d).toEqual({ set: { twitter: "new", updatedAtBlock: 5n }, unset: ["website"] });
  });
  it("diffCause flags deactivation", () => {
    const c = { causeId: "x", orgId: "o", orgAddress: PLATFORM, name: "n", active: true } as const;
    expect(diffCause(c, { ...c })).toBeNull();
    expect(diffCause(c, { ...c, active: false })).toEqual({ set: { active: false }, unset: [] });
  });
});

describe("planReconcile", () => {
  const stored = <V>(key: Hex, values: V, over: Partial<{ owner: string; expiresAt: bigint }> = {}) => ({
    key,
    owner: (over.owner ?? BURN_OWNER) as Hex,
    creator: PLATFORM as Hex,
    expiresAt: over.expiresAt ?? 10_000_000n,
    values,
  });
  const base = { chainId: 1, existingCores: [], existingProfiles: [], currentBlock: 1_000n, renewBeforeBlocks: 1_296_000n };

  it("creates core + profile for a new token, once even if listed twice", () => {
    const t = token();
    const plan = planReconcile({ ...base, indexerTokens: [t, t] });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.core.token).toBe(t.address);
    expect(plan.creates[0]!.profile.token).toBe(t.address);
    expect(planHasWrites(plan)).toBe(true);
  });

  it("defers tokens without a label (cores are immutable)", () => {
    const plan = planReconcile({ ...base, indexerTokens: [token({ label: undefined })] });
    expect(plan.creates).toHaveLength(0);
    expect(plan.deferred).toHaveLength(1);
    expect(planHasWrites(plan)).toBe(false);
    expect(planReconcile({ ...base, requireLabel: false, indexerTokens: [token({ label: undefined })] }).creates).toHaveLength(1);
  });

  it("is empty when Arkiv matches the indexer", () => {
    const t = token();
    const core: StoredCore = stored(K(1), toTokenCore(t, 1));
    const profile: StoredProfile = stored(K(2), toTokenProfile(t, K(1), 1), { owner: PLATFORM });
    const plan = planReconcile({ ...base, indexerTokens: [t], existingCores: [core], existingProfiles: [profile] });
    expect(planHasWrites(plan)).toBe(false);
    expect(plan.conflicts).toEqual([]);
  });

  it("burns unburned cores, creates missing profiles, patches changed ones", () => {
    const a = token();
    const b = token();
    const coreA = stored(K(1), toTokenCore(a, 1), { owner: PLATFORM });
    const coreB = stored(K(3), toTokenCore(b, 1));
    const profB = stored(K(4), toTokenProfile(b, K(3), 1), { owner: PLATFORM });
    const bChanged = { ...b, textRecords: { ...b.textRecords, "com.twitter": "changed" } };
    const plan = planReconcile({ ...base, indexerTokens: [a, bChanged], existingCores: [coreA, coreB], existingProfiles: [profB] });
    expect(plan.burns).toEqual([K(1)]);
    expect(plan.profileCreates).toHaveLength(1);
    expect(plan.profileCreates[0]!.core).toBe(K(1));
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]!.diff.set).toMatchObject({ twitter: "changed" });
  });

  it("extends entities expiring within the window", () => {
    const t = token();
    const core = stored(K(1), toTokenCore(t, 1), { expiresAt: 500_000n });
    const profile = stored(K(2), toTokenProfile(t, K(1), 1), { owner: PLATFORM, expiresAt: 5_000_000n });
    const plan = planReconcile({ ...base, indexerTokens: [t], existingCores: [core], existingProfiles: [profile] });
    expect(plan.extends).toEqual([K(1)]);
  });

  it("reports core conflicts without rewriting, and picks one core among duplicates", () => {
    const t = token();
    const good = stored(K(5), toTokenCore(t, 1));
    const odd = stored(K(2), { ...toTokenCore(t, 1), poolId: "0xdead" }, { owner: PLATFORM });
    const plan = planReconcile({ ...base, indexerTokens: [t], existingCores: [odd, good] });
    expect(plan.burns).toEqual([]); // the burned duplicate wins
    expect(plan.conflicts).toEqual([]);
    expect(plan.profileCreates[0]!.core).toBe(K(5));
    const conflict = planReconcile({ ...base, indexerTokens: [t], existingCores: [odd] });
    expect(conflict.conflicts).toEqual([{ token: t.address, key: K(2), fields: ["poolId"] }]);
  });

  it("ignores entities from other chains", () => {
    const t = token();
    const other = stored(K(1), { ...toTokenCore(t, 1), chainId: 11155111n });
    expect(planReconcile({ ...base, indexerTokens: [t], existingCores: [other] }).creates).toHaveLength(1);
  });

  it("plans cause creates and patches", () => {
    const c1 = IndexerCauseSchema.parse({ causeId: K(1), payout: PLATFORM, active: true });
    const c2 = IndexerCauseSchema.parse({ causeId: K(2), payout: PLATFORM, active: false });
    const existing = [stored(K(9), { ...toCause(c2), active: true }, { owner: PLATFORM })];
    const plan = planReconcile({ ...base, indexerTokens: [], indexerCauses: [c1, c2], existingCauses: existing });
    expect(plan.causeCreates.map((c) => c.causeId)).toEqual([K(1)]);
    expect(plan.causePatches).toEqual([{ key: K(9), causeId: K(2), diff: { set: { active: false }, unset: [] } }]);
  });
});
