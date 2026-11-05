import { describe, expect, it } from "vitest";
import {
  SWARM_CONTENTHASH_PREFIX,
  bytes32ToSwarmReference,
  bzzUri,
  isEncryptedSwarmReference,
  isSwarmContenthash,
  isSwarmReference,
  normalizeSwarmReference,
  swarmContenthash,
  swarmGatewayUrl,
  swarmReferenceFromContenthash,
  swarmReferenceToBytes32,
} from "../src/swarm.js";

const REF = "d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";
// ENSIP-7 example vector for bzz://<REF>
const CONTENTHASH = `0xe40101fa011b20${REF}` as const;

describe("swarm references", () => {
  it("normalizes prefixes and case", () => {
    expect(normalizeSwarmReference(`bzz://${REF.toUpperCase()}`)).toBe(REF);
    expect(normalizeSwarmReference(`0x${REF}`)).toBe(REF);
    expect(isSwarmReference(`bzz://${REF}`)).toBe(true);
    expect(isSwarmReference("abc")).toBe(false);
  });

  it("rejects encrypted and malformed references", () => {
    expect(isEncryptedSwarmReference(REF + REF)).toBe(true);
    expect(() => normalizeSwarmReference(REF + REF)).toThrow(/encrypted/);
    expect(() => normalizeSwarmReference("zz" + REF.slice(2))).toThrow(/64 hex/);
  });

  it("round-trips bytes32 and bzz uri", () => {
    expect(swarmReferenceToBytes32(REF)).toBe(`0x${REF}`);
    expect(bytes32ToSwarmReference(`0x${REF}`)).toBe(REF);
    expect(bytes32ToSwarmReference(`0x${"0".repeat(64)}`)).toBeNull();
    expect(bzzUri(`0x${REF}`)).toBe(`bzz://${REF}`);
  });
});

describe("contenthash", () => {
  it("matches the ENSIP-7 vector", () => {
    expect(swarmContenthash(REF)).toBe(CONTENTHASH);
    expect(CONTENTHASH.startsWith(SWARM_CONTENTHASH_PREFIX)).toBe(true);
    // 7 prefix bytes + 32 reference bytes
    expect((CONTENTHASH.length - 2) / 2).toBe(39);
  });

  it("decodes and rejects other codecs", () => {
    expect(swarmReferenceFromContenthash(CONTENTHASH.toUpperCase())).toBe(REF);
    expect(isSwarmContenthash(`0xe3010170${REF}`)).toBe(false); // ipfs
    expect(() => swarmReferenceFromContenthash(`0xe3010170${REF}`)).toThrow(/not a Swarm/);
    expect(isSwarmContenthash(CONTENTHASH + "00")).toBe(false);
  });
});

describe("gateway urls", () => {
  it("builds bzz paths", () => {
    expect(swarmGatewayUrl("https://gw.example/", REF)).toBe(`https://gw.example/bzz/${REF}/`);
    expect(swarmGatewayUrl("https://gw.example", `bzz://${REF}`, "/logo.png")).toBe(
      `https://gw.example/bzz/${REF}/logo.png`,
    );
  });
});
