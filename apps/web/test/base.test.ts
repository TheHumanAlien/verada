import { describe, expect, it } from "vitest";
import { siteBaseFromPath } from "@/lib/base";
import { readTokenAddress } from "@/lib/token-address";

describe("siteBaseFromPath", () => {
  it.each([
    ["/", "/"],
    ["/index.html", "/"],
    ["/launch/", "/"],
    ["/token/", "/"],
    ["/bzz/abc123/", "/bzz/abc123/"],
    ["/bzz/abc123", "/bzz/abc123/"],
    ["/bzz/abc123/causes/", "/bzz/abc123/"],
    ["/bzz/abc123/token/index.html", "/bzz/abc123/"],
  ])("%s -> %s", (path, base) => expect(siteBaseFromPath(path)).toBe(base));
});

describe("readTokenAddress", () => {
  const a = "0x00000000000000000000000000000000000000aa";
  it("reads query then hash and rejects junk", () => {
    expect(readTokenAddress(`?address=${a}`, "")).toBe(a);
    expect(readTokenAddress("", `#${a}`)).toBe(a);
    expect(readTokenAddress("?address=nope", "")).toBeNull();
    expect(readTokenAddress("", "")).toBeNull();
  });
});
