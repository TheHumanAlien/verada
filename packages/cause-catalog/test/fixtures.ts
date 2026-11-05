import type { HarvestedOrg } from "../src/harvest.js";

export function org(n: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg {
  const ein = String(100000000 + n);
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    ein,
    name: `Org ${n}`,
    description: null,
    nteeCode: "K31",
    country: "USA",
    state: "NY",
    isCompliant: true,
    claimed: false,
    donationsReceived: 0,
    mainnetAddress: "0x000000000000000000000000000000000000beef",
    ...over,
  };
}
