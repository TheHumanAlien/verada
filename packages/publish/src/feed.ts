import { Bee, PrivateKey, Topic } from "@ethersphere/bee-js";
import { swarmReferenceToContenthash, normalizeReference } from "./contenthash.js";

/** Topic of the feed that points at the current site release. */
export const SITE_FEED_TOPIC = "verada-site";

export interface FeedIdentity {
  /** Feed owner (address of the signing key), `0x`-prefixed. */
  owner: `0x${string}`;
  /** Human-readable topic. */
  topic: string;
  /** `keccak256(topic)` as Bee expects it, `0x`-prefixed. */
  topicHex: `0x${string}`;
}

function toKey(privateKey: string): PrivateKey {
  const hex = privateKey.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("feed private key must be 32 bytes of hex");
  return new PrivateKey(hex);
}

/**
 * Derives the feed owner and topic hash from a signing key. Pure, no network. The key only ever
 * signs Swarm feed updates (single-owner chunks); it holds no funds and is never logged.
 */
export function feedIdentity(privateKey: string, topic: string = SITE_FEED_TOPIC): FeedIdentity {
  const key = toKey(privateKey);
  return {
    owner: `0x${key.publicKey().address().toHex()}`,
    topic,
    topicHex: `0x${Topic.fromString(topic).toHex()}`,
  };
}

export interface FeedUpdateOpts {
  beeUrl: string;
  batchId: string;
  privateKey: string;
  topic?: string;
  /** Swarm reference of the new site release (64 hex). */
  reference: string;
}

export interface FeedUpdateResult extends FeedIdentity {
  /** Reference written to the feed (the site release). */
  reference: string;
  /**
   * Feed manifest reference: stable for a given owner and topic. Set the ENS contenthash to this
   * once; later releases only need another feed update.
   */
  feedManifest: string;
  /** EIP-1577 contenthash for the feed manifest. */
  contenthash: `0x${string}`;
}

/**
 * Appends `reference` to the site feed and (idempotently) creates the feed manifest. Only
 * reached with an explicit --execute from the CLI. Requires an immutable postage batch.
 */
export async function updateSiteFeed(o: FeedUpdateOpts): Promise<FeedUpdateResult> {
  const topic = o.topic ?? SITE_FEED_TOPIC;
  const identity = feedIdentity(o.privateKey, topic);
  const reference = normalizeReference(o.reference);
  const bee = new Bee(o.beeUrl);
  const writer = bee.makeFeedWriter(Topic.fromString(topic), toKey(o.privateKey));
  await writer.uploadReference(o.batchId, reference);
  const manifest = await bee.createFeedManifest(o.batchId, Topic.fromString(topic), identity.owner.slice(2));
  const feedManifest = manifest.toHex();
  return { ...identity, reference, feedManifest, contenthash: swarmReferenceToContenthash(feedManifest) };
}

export interface FeedReadOpts {
  beeUrl: string;
  owner: string;
  topic?: string;
}

/** Reads the latest reference of a feed (read-only). */
export async function readSiteFeed(o: FeedReadOpts): Promise<{ reference: string; feedIndex: string }> {
  const bee = new Bee(o.beeUrl);
  const reader = bee.makeFeedReader(Topic.fromString(o.topic ?? SITE_FEED_TOPIC), o.owner.replace(/^0x/i, ""));
  const res = await reader.downloadReference();
  return { reference: res.reference.toHex(), feedIndex: res.feedIndex.toString() };
}
