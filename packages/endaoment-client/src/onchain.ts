import { getAddress, isAddressEqual, parseAbi, type Address, type PublicClient } from "viem";
import { toOrgId, type OrgIdentity } from "./cause.js";
import type { OrgDeployment } from "./schemas.js";

/** Ethereum mainnet. */
export const MAINNET_CHAIN_ID = 1;
/** Endaoment OrgFundFactory on Ethereum mainnet (verified on-chain). */
export const ORG_FUND_FACTORY: Address = "0x10fD9348136dCea154F752fe0B6dB45Fc298A589";
/** Endaoment Registry on Ethereum mainnet. */
export const ENDAOMENT_REGISTRY: Address = "0x94106cA9c7E567109A1D39413052887d1F412183";

export const orgFundFactoryAbi = parseAbi([
  "function computeOrgAddress(bytes32 orgId) view returns (address)",
]);

export interface MainnetOrg extends OrgIdentity {
  deployments: OrgDeployment[];
  isCompliant: boolean;
  claimed: boolean;
}

export interface MainnetDeployment {
  /** Deterministic CREATE2 address; valid even when the org is not deployed yet. */
  address: Address;
  /** Advisory only (API cache). Decide deploy-vs-donate from on-chain code. */
  isDeployed: boolean;
}

/** The chain 1 entry of `deployments[]` (array order is not guaranteed), or null. */
export function getMainnetDeployment(org: Pick<MainnetOrg, "deployments">): MainnetDeployment | null {
  const d = org.deployments.find((x) => x.chainId === MAINNET_CHAIN_ID);
  if (!d) return null;
  return { address: getAddress(d.contractAddress), isDeployed: d.isDeployed };
}

export interface OrgSummary {
  orgId: `0x${string}`;
  address: Address | null;
  /** Advisory only. */
  isDeployed: boolean;
  isCompliant: boolean;
  claimed: boolean;
}

export function summarizeOrg(org: MainnetOrg): OrgSummary {
  const d = getMainnetDeployment(org);
  return {
    orgId: toOrgId(org),
    address: d?.address ?? null,
    isDeployed: d?.isDeployed ?? false,
    isCompliant: org.isCompliant,
    claimed: org.claimed,
  };
}

/** The factory's CREATE2 address for the org. */
export async function computeOrgAddress(
  client: Pick<PublicClient, "readContract">,
  org: OrgIdentity,
  factory: Address = ORG_FUND_FACTORY,
): Promise<Address> {
  return client.readContract({
    address: factory,
    abi: orgFundFactoryAbi,
    functionName: "computeOrgAddress",
    args: [toOrgId(org)],
  });
}

export interface OrgAddressCheck {
  ok: boolean;
  orgId: `0x${string}`;
  /** Address the API reported for chain 1 (null if absent). */
  apiAddress: Address | null;
  /** Address the factory computes from the derived orgId. */
  computedAddress: Address;
}

/**
 * Verifies that the orgId derived from the API record maps to the API's chain 1 address
 * according to the factory. Only a matching result should be written to CauseRegistry.
 */
export async function verifyOrgAddress(
  client: Pick<PublicClient, "readContract">,
  org: MainnetOrg,
  factory: Address = ORG_FUND_FACTORY,
): Promise<OrgAddressCheck> {
  const computedAddress = await computeOrgAddress(client, org, factory);
  const apiAddress = getMainnetDeployment(org)?.address ?? null;
  return {
    ok: apiAddress !== null && isAddressEqual(apiAddress, computedAddress),
    orgId: toOrgId(org),
    apiAddress,
    computedAddress,
  };
}
