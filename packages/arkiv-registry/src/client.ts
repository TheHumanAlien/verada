import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type Expiry,
  type FullRow,
  type PublicArkivClient,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { localhost, rabdi } from "@arkiv-network/sdk/chains";
import { asc, gt } from "@arkiv-network/sdk/query";
import { addr, bool, bytes, i32, key, str, u64 } from "@arkiv-network/sdk/schema";
import { hexToString, http, stringToHex, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { diffCause } from "./mapping.js";
import { BURN_OWNER, Cause, TokenCore, TokenProfile } from "./schemas.js";
import type {
  CauseDiff,
  CauseValues,
  CoreValues,
  ProfileDiff,
  ProfileDraft,
  ProfileValues,
  StoredCause,
  StoredCore,
  StoredProfile,
} from "./types.js";

export type ArkivChainName = "rabdi" | "localhost";

/** Structured logger; messages and data must never carry secrets. */
export interface RegistryLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const consoleLogger: RegistryLogger = {
  info: (msg, data) => console.log(JSON.stringify({ level: "info", msg, ...data }, bigintSafe)),
  warn: (msg, data) => console.warn(JSON.stringify({ level: "warn", msg, ...data }, bigintSafe)),
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, ...data }, bigintSafe)),
};

/** The read actions the registry uses; a fake can stand in for tests. */
export interface RegistryPublicClient {
  select: PublicArkivClient["select"];
  getBlockTiming: PublicArkivClient["getBlockTiming"];
  predictEntityKeys: PublicArkivClient["predictEntityKeys"];
}

/** The write actions the registry uses; a fake can stand in for tests. */
export interface RegistryWalletClient {
  account: { address: Address };
  executeBatch: WalletArkivClient["executeBatch"];
  patchEntity: WalletArkivClient["patchEntity"];
}

export interface ArkivRegistryOptions {
  chain: ArkivChainName;
  /** Arkiv RPC access key. It travels in the RPC URL path, so URLs and RPC errors are redacted. */
  accessKey?: string;
  /** Platform signer. Its address is the `$creator` readers must trust. */
  privateKey?: Hex;
  /** Overrides the chain's default RPC URL. */
  rpcUrl?: string;
  /** Log every write instead of sending it. */
  dryRun?: boolean;
  logger?: RegistryLogger;
  /** Rows per query page (Arkiv caps a page at 100). */
  pageSize?: number;
  /** Lifetime of new entities and of extensions (default: the protocol maximum, about 182 days). */
  lifetime?: () => Expiry;
  /** Inject clients (tests). When given, `privateKey`/`accessKey`/`rpcUrl` are not used. */
  clients?: { publicClient: RegistryPublicClient; walletClient: RegistryWalletClient };
}

export interface WriteResult {
  dryRun: boolean;
  txHashes: Hex[];
}

export interface CreateTokenResult extends WriteResult {
  coreKey: Hex | null;
  profileKey: Hex | null;
}

export interface ArkivRegistry {
  publicClient: RegistryPublicClient;
  walletClient: RegistryWalletClient;
  /** Platform account address (`$creator` of every entity this registry writes). */
  platform: Address;
  dryRun: boolean;
  currentBlock(): Promise<bigint>;
  listCores(): Promise<StoredCore[]>;
  listProfiles(): Promise<StoredProfile[]>;
  listCauses(): Promise<StoredCause[]>;
  /** Creates core + profile in one batch, then hands the core to `BURN_OWNER` in a second one. */
  createTokenRecords(core: CoreValues, profile: ProfileDraft): Promise<CreateTokenResult>;
  createProfile(profile: ProfileValues): Promise<WriteResult & { profileKey: Hex | null }>;
  burnCores(keys: Hex[]): Promise<WriteResult>;
  patchProfile(entityKey: Hex, diff: ProfileDiff): Promise<WriteResult>;
  extendExpiring(keys: Hex[], expiration?: Expiry): Promise<WriteResult>;
  /** Creates the cause, or patches `existing` when given and different. */
  upsertCause(values: CauseValues, existing?: { key: Hex; values: CauseValues }): Promise<WriteResult>;
  patchCause(entityKey: Hex, diff: CauseDiff): Promise<WriteResult>;
  /** Replaces secrets (the access key) in a message before it is logged. */
  redact(message: string): string;
}

/** Entities per extension / ownership batch; keeps each transaction well under the gas cap. */
export const WRITE_CHUNK = 32;
/** Upper bound on pages read per list call (100 rows each). */
export const MAX_PAGES = 10_000;

function chainFor(name: ArkivChainName, accessKey: string, rpcUrl?: string): Chain {
  const base: Chain = name === "rabdi" ? rabdi({ accessKey }) : localhost;
  if (!rpcUrl) return base;
  return { ...base, rpcUrls: { default: { http: [rpcUrl] } } };
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// ---- encoding (plain values -> Arkiv typed values) ----

export function encodeCore(v: CoreValues) {
  return {
    token: addr(v.token),
    chainId: u64(v.chainId),
    poolId: str(v.poolId),
    creator: addr(v.creator),
    launchBlock: u64(v.launchBlock),
    label: str(v.label),
    metadataUri: str(v.metadataUri),
    logoRef: str(v.logoRef),
    causeCategory: str(v.causeCategory),
    causeRegion: str(v.causeRegion),
    categoryMask: u64(v.categoryMask),
    regionMask: i32(v.regionMask),
    version: i32(v.version),
  };
}

export function encodeProfileFields(v: Partial<ProfileValues>) {
  const out: {
    core?: ReturnType<typeof key>;
    token?: ReturnType<typeof addr>;
    chainId?: ReturnType<typeof u64>;
    controller?: ReturnType<typeof addr>;
    editor?: ReturnType<typeof addr>;
    website?: ReturnType<typeof str>;
    twitter?: ReturnType<typeof str>;
    telegram?: ReturnType<typeof str>;
    discord?: ReturnType<typeof str>;
    description?: ReturnType<typeof bytes>;
    logoRef?: ReturnType<typeof str>;
    contenthash?: ReturnType<typeof str>;
    updatedAtBlock?: ReturnType<typeof u64>;
  } = {};
  if (v.core !== undefined) out.core = key(v.core);
  if (v.token !== undefined) out.token = addr(v.token);
  if (v.chainId !== undefined) out.chainId = u64(v.chainId);
  if (v.controller !== undefined) out.controller = addr(v.controller);
  if (v.editor !== undefined) out.editor = addr(v.editor);
  if (v.website !== undefined) out.website = str(v.website);
  if (v.twitter !== undefined) out.twitter = str(v.twitter);
  if (v.telegram !== undefined) out.telegram = str(v.telegram);
  if (v.discord !== undefined) out.discord = str(v.discord);
  if (v.description !== undefined) out.description = bytes(stringToHex(v.description));
  if (v.logoRef !== undefined) out.logoRef = str(v.logoRef);
  if (v.contenthash !== undefined) out.contenthash = str(v.contenthash);
  if (v.updatedAtBlock !== undefined) out.updatedAtBlock = u64(v.updatedAtBlock);
  return out;
}

export function encodeProfile(v: ProfileValues) {
  const f = encodeProfileFields(v);
  return {
    ...f,
    core: key(v.core),
    token: addr(v.token),
    chainId: u64(v.chainId),
    controller: addr(v.controller),
    editor: addr(v.editor),
    updatedAtBlock: u64(v.updatedAtBlock),
  };
}

export function encodeCauseFields(v: Partial<CauseValues>) {
  const out: {
    causeId?: ReturnType<typeof str>;
    orgId?: ReturnType<typeof str>;
    ein?: ReturnType<typeof str>;
    orgAddress?: ReturnType<typeof addr>;
    name?: ReturnType<typeof str>;
    nteeCode?: ReturnType<typeof str>;
    active?: ReturnType<typeof bool>;
  } = {};
  if (v.causeId !== undefined) out.causeId = str(v.causeId);
  if (v.orgId !== undefined) out.orgId = str(v.orgId);
  if (v.ein !== undefined) out.ein = str(v.ein);
  if (v.orgAddress !== undefined) out.orgAddress = addr(v.orgAddress);
  if (v.name !== undefined) out.name = str(v.name);
  if (v.nteeCode !== undefined) out.nteeCode = str(v.nteeCode);
  if (v.active !== undefined) out.active = bool(v.active);
  return out;
}

export function encodeCause(v: CauseValues) {
  return {
    ...encodeCauseFields(v),
    causeId: str(v.causeId),
    orgId: str(v.orgId),
    orgAddress: addr(v.orgAddress),
    name: str(v.name),
    active: bool(v.active),
  };
}

// ---- decoding (Arkiv rows -> plain values) ----

type CoreRow = FullRow<typeof TokenCore>;
type ProfileRow = FullRow<typeof TokenProfile>;
type CauseRow = FullRow<typeof Cause>;

const system = (row: { $key: Hex; $owner: Hex; $creator: Hex; $expiresAt: bigint }) => ({
  key: row.$key.toLowerCase() as Hex,
  owner: row.$owner as Address,
  creator: row.$creator as Address,
  expiresAt: row.$expiresAt,
});

export function decodeCore(row: CoreRow): StoredCore {
  return {
    ...system(row),
    values: {
      token: row.token.value,
      chainId: row.chainId.value,
      poolId: row.poolId.value,
      creator: row.creator.value,
      launchBlock: row.launchBlock.value,
      label: row.label.value,
      metadataUri: row.metadataUri.value,
      logoRef: row.logoRef.value,
      causeCategory: row.causeCategory.value,
      causeRegion: row.causeRegion.value,
      categoryMask: row.categoryMask.value,
      regionMask: row.regionMask.value,
      version: row.version.value,
    },
  };
}

export function decodeProfile(row: ProfileRow): StoredProfile {
  const values: ProfileValues = {
    core: row.core.value.toLowerCase() as Hex,
    token: row.token.value,
    chainId: row.chainId.value,
    controller: row.controller.value,
    editor: row.editor.value,
    updatedAtBlock: row.updatedAtBlock.value,
  };
  if (row.website) values.website = row.website.value;
  if (row.twitter) values.twitter = row.twitter.value;
  if (row.telegram) values.telegram = row.telegram.value;
  if (row.discord) values.discord = row.discord.value;
  if (row.description) values.description = hexToString(row.description.value);
  if (row.logoRef) values.logoRef = row.logoRef.value;
  if (row.contenthash) values.contenthash = row.contenthash.value;
  return { ...system(row), values };
}

export function decodeCause(row: CauseRow): StoredCause {
  const values: CauseValues = {
    causeId: row.causeId.value,
    orgId: row.orgId.value,
    orgAddress: row.orgAddress.value,
    name: row.name.value,
    active: row.active.value,
  };
  if (row.ein) values.ein = row.ein.value;
  if (row.nteeCode) values.nteeCode = row.nteeCode.value;
  return { ...system(row), values };
}

/**
 * Builds the Arkiv registry for the platform account. Every list call reads only entities whose
 * `$creator` is the platform, so entities other accounts write under the same schema names
 * (the `arkiv.schema` tag is spoofable) are never trusted.
 */
export function createArkivRegistry(opts: ArkivRegistryOptions): ArkivRegistry {
  const log = opts.logger ?? consoleLogger;
  const dryRun = opts.dryRun ?? false;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
  const lifetime = opts.lifetime ?? (() => ExpirationTime.max());
  const accessKey = opts.accessKey ?? "";

  let publicClient: RegistryPublicClient;
  let walletClient: RegistryWalletClient;
  if (opts.clients) {
    ({ publicClient, walletClient } = opts.clients);
  } else {
    if (!opts.privateKey) throw new Error("createArkivRegistry: privateKey is required");
    const chain = chainFor(opts.chain, accessKey, opts.rpcUrl);
    const account = privateKeyToAccount(opts.privateKey);
    publicClient = createPublicClient({ chain, transport: http() });
    walletClient = createWalletClient({ chain, transport: http(), account });
  }
  const platform = walletClient.account.address;

  const secrets = [accessKey, encodeURIComponent(accessKey)].filter((s) => s.length >= 4);
  const redact = (message: string) => {
    let m = message;
    for (const s of secrets) m = m.split(s).join("***");
    return m;
  };

  /** Keyset pagination: `ORDER BY $key`, each page continuing after the last key seen. */
  async function pageAll<R>(fetchPage: (after: Hex | undefined) => Promise<readonly R[]>, keyOf: (r: R) => Hex) {
    const out: R[] = [];
    let after: Hex | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(after);
      out.push(...rows);
      if (rows.length < pageSize) return out;
      after = keyOf(rows[rows.length - 1]!);
    }
    throw new Error("arkiv list exceeded MAX_PAGES");
  }

  const listCores = async () =>
    (
      await pageAll(async (after) => {
        const q = publicClient.select().from(TokenCore, { onMismatch: "throw" }).createdBy(platform);
        if (after) q.where(gt("$key", key(after)));
        return (await q.orderBy(asc("$key")).limit(pageSize).fetch()).entities;
      }, (r) => r.$key)
    ).map(decodeCore);

  const listProfiles = async () =>
    (
      await pageAll(async (after) => {
        const q = publicClient.select().from(TokenProfile, { onMismatch: "throw" }).createdBy(platform);
        if (after) q.where(gt("$key", key(after)));
        return (await q.orderBy(asc("$key")).limit(pageSize).fetch()).entities;
      }, (r) => r.$key)
    ).map(decodeProfile);

  const listCauses = async () =>
    (
      await pageAll(async (after) => {
        const q = publicClient.select().from(Cause, { onMismatch: "throw" }).createdBy(platform);
        if (after) q.where(gt("$key", key(after)));
        return (await q.orderBy(asc("$key")).limit(pageSize).fetch()).entities;
      }, (r) => r.$key)
    ).map(decodeCause);

  const skipped = (op: string, data: Record<string, unknown>) => {
    log.info(`dry-run: ${op}`, data);
    return { dryRun: true, txHashes: [] as Hex[] };
  };

  async function burnCores(keys: Hex[]): Promise<WriteResult> {
    if (keys.length === 0) return { dryRun, txHashes: [] };
    if (dryRun) return skipped("burn cores", { keys });
    const txHashes: Hex[] = [];
    for (const group of chunk(keys, WRITE_CHUNK)) {
      const r = await walletClient.executeBatch({
        ownershipChanges: group.map((entityKey) => ({ entityKey, newOwner: BURN_OWNER })),
      });
      txHashes.push(r.txHash);
    }
    return { dryRun: false, txHashes };
  }

  return {
    publicClient,
    walletClient,
    platform,
    dryRun,
    redact,
    async currentBlock() {
      return (await publicClient.getBlockTiming()).currentBlock;
    },
    listCores,
    listProfiles,
    listCauses,

    async createTokenRecords(core, profile) {
      if (dryRun) {
        return { ...skipped("create token records", { token: core.token, label: core.label }), coreKey: null, profileKey: null };
      }
      // Predict both keys so the profile can reference the core created in the same transaction.
      const [c, p] = await publicClient.predictEntityKeys({ owner: platform, count: 2 });
      const expiration = lifetime();
      const created = await walletClient.executeBatch({
        creates: [
          {
            schema: TokenCore,
            values: encodeCore(core),
            expiration,
            flags: { readonly: true, permissionlessExtension: true },
            salt: c.salt,
          },
          {
            schema: TokenProfile,
            values: encodeProfile({ ...profile, core: c.key }),
            expiration,
            flags: { permissionlessExtension: true },
            salt: p.salt,
          },
        ],
      });
      const coreKey = created.createdEntities[0];
      const profileKey = created.createdEntities[1] ?? null;
      if (!coreKey) throw new Error("arkiv batch returned no core key");
      if (coreKey.toLowerCase() !== c.key.toLowerCase()) {
        // Another write moved the nonce; the next reconcile patches the profile's `core` field.
        log.warn("predicted core key differs from minted key", { token: core.token, coreKey });
      }
      const burned = await burnCores([coreKey]);
      log.info("created token records", { token: core.token, coreKey, profileKey });
      return { dryRun: false, coreKey, profileKey, txHashes: [created.txHash, ...burned.txHashes] };
    },

    async createProfile(profile) {
      if (dryRun) return { ...skipped("create profile", { token: profile.token, core: profile.core }), profileKey: null };
      const r = await walletClient.executeBatch({
        creates: [
          {
            schema: TokenProfile,
            values: encodeProfile(profile),
            expiration: lifetime(),
            flags: { permissionlessExtension: true },
          },
        ],
      });
      return { dryRun: false, txHashes: [r.txHash], profileKey: r.createdEntities[0] ?? null };
    },

    burnCores,

    async patchProfile(entityKey, diff) {
      if (dryRun) return skipped("patch profile", { key: entityKey, set: Object.keys(diff.set), unset: diff.unset });
      const r = await walletClient.patchEntity(TokenProfile, entityKey, {
        set: encodeProfileFields(diff.set),
        unset: diff.unset,
      });
      return { dryRun: false, txHashes: [r.txHash] };
    },

    async extendExpiring(keys, expiration) {
      if (keys.length === 0) return { dryRun, txHashes: [] };
      if (dryRun) return skipped("extend entities", { keys });
      const txHashes: Hex[] = [];
      for (const group of chunk(keys, WRITE_CHUNK)) {
        const e = expiration ?? lifetime();
        const r = await walletClient.executeBatch({
          extensions: group.map((entityKey) => ({ entityKey, expiration: e })),
        });
        txHashes.push(r.txHash);
      }
      return { dryRun: false, txHashes };
    },

    async upsertCause(values, existing) {
      if (existing) {
        const diff = diffCause(existing.values, values);
        if (!diff) return { dryRun, txHashes: [] };
        return this.patchCause(existing.key, diff);
      }
      if (dryRun) return skipped("create cause", { causeId: values.causeId });
      const r = await walletClient.executeBatch({
        creates: [
          { schema: Cause, values: encodeCause(values), expiration: lifetime(), flags: { permissionlessExtension: true } },
        ],
      });
      return { dryRun: false, txHashes: [r.txHash] };
    },

    async patchCause(entityKey, diff) {
      if (dryRun) return skipped("patch cause", { key: entityKey, set: Object.keys(diff.set), unset: diff.unset });
      const r = await walletClient.patchEntity(Cause, entityKey, {
        set: encodeCauseFields(diff.set),
        unset: diff.unset,
      });
      return { dryRun: false, txHashes: [r.txHash] };
    },
  };
}
