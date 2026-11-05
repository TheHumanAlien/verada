import { z } from "zod";

/** Image/logo fields are intentionally not declared; zod strips unknown keys. */

export const OrgAddressSchema = z.object({
  line1: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export const OrgDeploymentSchema = z.object({
  chainId: z.number(),
  contractAddress: z.string(),
  usdcBalance: z.union([z.string(), z.number()]).nullable().optional(),
  isDeployed: z.boolean(),
});

const ClaimedType = z.enum(["WalletClaim", "WireClaim"]).nullable().optional();

const shared = {
  id: z.string(),
  ein: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  address: OrgAddressSchema,
  website: z.string().nullable().optional(),
  nteeCode: z.string().nullable().optional(),
  nteeDescription: z.string().nullable().optional(),
  featuredIndex: z.number(),
  isCompliant: z.boolean(),
  lifetimeContributionsUsdc: z.string(),
  donationsReceived: z.number(),
  grantsReceived: z.number(),
  deployments: z.array(OrgDeploymentSchema),
  claimedDateUtc: z.string().nullable().optional(),
  claimedType: ClaimedType,
  claimed: z.boolean(),
};

export const OrgSearchListingSchema = z.object(shared);
export const OrgSearchResponseSchema = z.array(OrgSearchListingSchema);

export const OrgDetailsSchema = z.object({
  ...shared,
  id: z.string().nullable(),
  nonComplianceReasons: z.array(z.string()).nullable().optional(),
  usdcBalance: z.string().optional(),
  partnerId: z.enum(["tgb", "gg"]).nullable().optional(),
});

export const OrgCountsResponseSchema = z.object({
  counts: z.array(z.object({ nteeCode: z.string(), orgCount: z.number().int().nonnegative() })),
  asOf: z.string(),
});

export type OrgCountsResponse = z.infer<typeof OrgCountsResponseSchema>;
export type OrgAddress = z.infer<typeof OrgAddressSchema>;
export type OrgDeployment = z.infer<typeof OrgDeploymentSchema>;
export type OrgSearchListing = z.infer<typeof OrgSearchListingSchema>;
export type OrgDetails = z.infer<typeof OrgDetailsSchema>;
