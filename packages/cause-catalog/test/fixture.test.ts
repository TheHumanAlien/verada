import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contractFixture } from "../src/fixture.js";

describe("contract fixture", () => {
  it("matches the committed fixture the Solidity tests verify", () => {
    const path = fileURLToPath(new URL("../../../contracts/test/fixtures/catalog.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.parse(JSON.stringify(contractFixture()))).toEqual(committed);
  });
});
