import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, keccak256, toHex } from "viem";
import { decodeFheBallot, encodePlainBallot } from "@verada/sdk";
import type { Encryptor } from "@/lib/ballot";
import { parseChoice, plainVoteAdapter, selectVoteAdapter, toCauseId, zamaVoteAdapter, type BallotRequest } from "@/lib/vote-adapter";

const req: BallotRequest = {
  scheme: "0x00000000000000000000000000000000000000c1",
  governor: "0x00000000000000000000000000000000000000c2",
  token: "0x00000000000000000000000000000000000000c3",
  scope: 7n,
  choice: 2,
  voter: "0x00000000000000000000000000000000000000a1",
};
const handle = `0x${"11".repeat(32)}` as const;
const inputProof = "0xdeadbeef" as const;

describe("vote adapters", () => {
  it("hashes plain identifiers and passes bytes32 through", () => {
    expect(toCauseId("53-0196605")).toBe(keccak256(toHex("53-0196605")));
    const id = `0x${"ab".repeat(32)}` as const;
    expect(toCauseId(id)).toBe(id);
    expect(toCauseId("  ")).toBeNull();
  });

  it("zama adapter encrypts for (scheme, voter) and builds castBallot on the scheme", async () => {
    const encryptChoice = vi.fn(async () => ({ handle, inputProof }));
    const adapter = zamaVoteAdapter(async () => ({ encryptChoice }) as Encryptor);
    const call = await adapter.buildCall(req);
    expect(encryptChoice).toHaveBeenCalledWith({ contractAddress: req.scheme, userAddress: req.voter, choice: 2 });
    expect(call.functionName).toBe("castBallot");
    expect(call.args.slice(0, 3)).toEqual([req.governor, req.token, 7n]);
    expect(decodeFheBallot(call.args[3])).toEqual({ handle, inputProof });
    expect(adapter.private).toBe(true);
    expect(adapter.placeholder).toBe(false);
  });

  it("rejects out-of-range choices before encrypting", async () => {
    const encryptChoice = vi.fn();
    const adapter = zamaVoteAdapter(async () => ({ encryptChoice }) as unknown as Encryptor);
    await expect(adapter.buildCall({ ...req, choice: 32 })).rejects.toThrow();
    await expect(adapter.buildCall({ ...req, choice: -1 })).rejects.toThrow();
    expect(encryptChoice).not.toHaveBeenCalled();
  });

  it("plaintext adapter is only selected for development builds", async () => {
    const get = async () => ({ encryptChoice: vi.fn() }) as unknown as Encryptor;
    expect(selectVoteAdapter({ devPlainBallots: false }, get).id).toBe("zama-fhe");
    expect(selectVoteAdapter({ devPlainBallots: true }, get)).toBe(plainVoteAdapter);
    const call = await plainVoteAdapter.buildCall(req);
    expect(call.args[3]).toBe(encodePlainBallot(2));
    expect(decodeAbiParameters([{ type: "uint8" }], call.args[3])[0]).toBe(2);
    expect(plainVoteAdapter.private).toBe(false);
  });

  it("parses a typed option index", () => {
    expect(parseChoice("1", 3)).toBe(1);
    expect(typeof parseChoice("3", 3)).toBe("string");
    expect(typeof parseChoice("", 3)).toBe("string");
    expect(typeof parseChoice("1.5", 3)).toBe("string");
  });
});
