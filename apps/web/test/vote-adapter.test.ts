import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { parseVoteRequest, publicPlaceholderAdapter, toCauseId } from "@/lib/vote-adapter";

const token = "0x0000000000000000000000000000000000000001";

describe("vote adapter", () => {
  it("hashes plain identifiers and passes bytes32 through", () => {
    expect(toCauseId("53-0196605")).toBe(keccak256(toHex("53-0196605")));
    const id = `0x${"ab".repeat(32)}` as const;
    expect(toCauseId(id)).toBe(id);
    expect(toCauseId("  ")).toBeNull();
  });

  it("rejects bad token addresses", () => {
    expect(typeof parseVoteRequest("nope", "x")).toBe("string");
  });

  it("placeholder adapter builds a castVote call with an empty proof", async () => {
    const req = parseVoteRequest(token, "x");
    if (typeof req === "string") throw new Error(req);
    const call = await publicPlaceholderAdapter.buildCall(req);
    expect(call.functionName).toBe("castVote");
    expect(call.args[2]).toBe("0x");
    expect(publicPlaceholderAdapter.placeholder).toBe(true);
  });
});
