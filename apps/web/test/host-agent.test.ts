import { describe, expect, it } from "vitest";
import { agentFromLocation, agentGatewayUrl, tokenLabelFromLocation } from "@/lib/host";

const loc = (hostname: string, search = "") => ({ hostname, search });

describe("agentFromLocation", () => {
  it.each([
    ["homeless.agent.varada.eth.limo", "", "homeless"],
    ["HOMELESS.agent.varada.eth.limo", "", "homeless"],
    ["homeless.agent.varada.eth.link", "", "homeless"],
    ["homeless.agent.varada.bzz.link", "", "homeless"],
    ["agent.varada.eth.limo", "", ""],
    ["unknown-cause.agent.varada.eth.limo", "", ""],
    ["Bad_Label.agent.varada.eth.limo", "", ""],
    ["varada.eth.limo", "", null],
    ["pepe.varada.eth.limo", "", null],
    ["a.homeless.agent.varada.eth.limo", "", null],
    ["homeless.agent.other.eth.limo", "", null],
    ["localhost", "", null],
    ["localhost", "?agent=homeless", "homeless"],
    ["localhost", "?agent=Homeless", "homeless"],
    ["localhost", "?agent=", ""],
    ["localhost", "?agent=nope", null],
    ["pepe.varada.eth.limo", "?agent=homeless", "homeless"],
    ["homeless.agent.varada.eth.limo", "?agent=nope", null],
  ])("%s%s -> %j", (hostname, search, expected) => {
    expect(agentFromLocation(loc(hostname, search))).toBe(expected);
  });

  it("follows a custom parent name", () => {
    expect(agentFromLocation(loc("homeless.agent.example.eth.limo"), "example.eth")).toBe("homeless");
    expect(agentFromLocation(loc("homeless.agent.varada.eth.limo"), "example.eth")).toBeNull();
  });

  it("returns null without a location", () => {
    expect(agentFromLocation(undefined)).toBeNull();
  });

  it("builds agent gateway URLs", () => {
    expect(agentGatewayUrl("homeless")).toBe("https://homeless.agent.varada.eth.limo/");
    expect(agentGatewayUrl("")).toBe("https://agent.varada.eth.limo/");
  });
});

describe("tokenLabelFromLocation on agent pages", () => {
  it.each([
    ["homeless.agent.varada.eth.limo", ""],
    ["agent.varada.eth.limo", ""],
    ["homeless.agent.varada.eth.limo", "?label=pepe"],
    ["agent.varada.eth.limo", "?label=pepe"],
    ["localhost", "?agent=homeless&label=pepe"],
    ["pepe.varada.eth.limo", "?agent=homeless"],
  ])("%s%s -> null", (hostname, search) => {
    expect(tokenLabelFromLocation(loc(hostname, search))).toBeNull();
  });

  it("keeps token hosts and overrides working", () => {
    expect(tokenLabelFromLocation(loc("pepe.varada.eth.limo"))).toBe("pepe");
    expect(tokenLabelFromLocation(loc("localhost", "?label=moon-cat"))).toBe("moon-cat");
    // An unknown ?agent= is not an agent page, so the token label still applies.
    expect(tokenLabelFromLocation(loc("pepe.varada.eth.limo", "?agent=nope"))).toBe("pepe");
  });
});
