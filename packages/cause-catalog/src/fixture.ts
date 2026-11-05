import { ALL_CATEGORIES_MASK, ALL_REGIONS_MASK, categoryMaskOf, drawIndex, locate, poolSize, regionMaskOf } from "@verada/sdk";
import type { Address, Hex } from "viem";
import { buildCatalog, entryProof } from "./build.js";
import type { HarvestedOrg } from "./harvest.js";

/**
 * Cross-language fixture: a small catalogue built by the real builder, with proofs and rotation
 * vectors, that `contracts/test/CatalogFixtureCompat.t.sol` verifies against `CauseCatalog` and
 * `EpochGovernor`. Regenerate with `pnpm --filter @verada/cause-catalog gen:fixture`.
 */
export function contractFixture() {
  const orgs: HarvestedOrg[] = [
    ["Kenya Famine Relief", "Z00", "KEN", "feeding program for children"],
    ["Hope Food Bank", "K31", "USA", null],
    ["Shelter Now", "L41", "USA", null],
    ["Rhino Watch", "D31", "ZAF", null],
    ["Global Cancer Lab", "H30", "GBR", null],
    ["Relief Without Borders", "Q33", "USA", "earthquake and famine relief in Haiti and Somalia"],
    ["Mumbai Street Kids", "Z00", "IND", "street children education"],
  ].map(([name, nteeCode, country, description], i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    ein: String(300000000 + i),
    name: name!,
    description: description ?? null,
    nteeCode: nteeCode!,
    country: country!,
    state: null,
    isCompliant: true,
    claimed: false,
    donationsReceived: 0,
    mainnetAddress: "0x000000000000000000000000000000000000beef",
  }));
  const { catalog } = buildCatalog(orgs, { now: new Date("2026-11-06T00:00:00Z") });
  const entries = [...catalog.tree.entries()].map(([, [bucket, index, orgId]]) => ({
    bucket,
    index,
    orgId,
    proof: entryProof(catalog.tree, { bucket, index, orgId }),
  }));
  const token: Address = "0x00000000000000000000000000000000000000aa";
  const focus = { categoryMask: categoryMaskOf(["hunger", "children-youth"]), regionMask: regionMaskOf(["africa", "asia", "global"]) };
  const size = poolSize(catalog.meta.bucketSizes, focus.categoryMask, focus.regionMask);
  const draws = [0, 1, 2, 3, 4].map((k) => {
    const poolIndex = drawIndex(token, 3n, 1, k, size);
    return { k, poolIndex, ...locate(catalog.meta.bucketSizes, focus.categoryMask, focus.regionMask, poolIndex) };
  });
  return {
    root: catalog.meta.root as Hex,
    bucketSizes: catalog.meta.bucketSizes,
    entryCount: entries.length,
    entries,
    focus: { categoryMask: focus.categoryMask.toString(), regionMask: focus.regionMask, poolSize: size },
    anyPoolSize: poolSize(catalog.meta.bucketSizes, ALL_CATEGORIES_MASK, ALL_REGIONS_MASK),
    rotation: { token, epoch: 3, version: 1, draws },
  };
}
