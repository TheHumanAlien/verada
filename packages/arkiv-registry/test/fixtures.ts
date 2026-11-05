import { IndexerTokenSchema, type IndexerToken } from "../src/index.js";

export const CREATOR = "0x2222222222222222222222222222222222222222";
export const LOGO = "a".repeat(64);
export const POOL = `0x${"cd".repeat(32)}`;

let n = 0;
/** An indexer token row in the shape the API serves (bigints as strings). */
export function rawToken(over: Record<string, unknown> = {}) {
  n++;
  return {
    address: `0x${(0xabc000 + n).toString(16).padStart(40, "0")}`,
    creator: CREATOR,
    pool: POOL,
    hook: "0x3333333333333333333333333333333333333333",
    lpTokenId: "7",
    feeBps: 100,
    metadataUri: `bzz://${LOGO}`,
    createdAt: "1730000000",
    createdBlock: "21000000",
    txHash: `0x${"ee".repeat(32)}`,
    feeTotals: null,
    label: `token-${n}`,
    logoRef: `0x${LOGO}`,
    textRecords: {
      url: "https://example.org",
      description: "A token for good causes",
      "com.twitter": "verada",
    },
    ...over,
  };
}

export const token = (over: Record<string, unknown> = {}): IndexerToken => IndexerTokenSchema.parse(rawToken(over));
