# @verada/endaoment-client

Typed, zod-validated client for the Endaoment public API (organization search and lookup).

```ts
import { EndaomentClient, toCauseId, summarizeOrg } from "@verada/endaoment-client";

const client = new EndaomentClient(); // production by default

const orgs = await client.searchOrganizations({
  searchTerm: "relief",
  nteeMajorCodes: ["P"],
  countries: ["USA"],
  subdivisions: ["NY"],
  count: 10,
  offset: 0,
});

const org = await client.getOrganization("53-0196605"); // EIN or Endaoment id; null on 404
const causeId = toCauseId(org!); // keccak256 of the 32-byte orgId
const { orgId, address, isCompliant, claimed } = summarizeOrg(org!);
```

## Endpoints

- `GET /v2/orgs/search`: `searchTerm`, `nteeMajorCodes`, `nteeMinorCodes`, `countries` (ISO alpha-3), `subdivisions` (US states), `count` (1-25), `offset`. List filters are sent comma-joined. The response is a bare array; use `searchAll()` to iterate pages.
- `GET /v1/orgs/{identifier}`: details by EIN or id, including `deployments` (per-chain `contractAddress`, `isDeployed`). Array order is not guaranteed; select the entry with `chainId` 1 (`getMainnetDeployment`). `isDeployed` is an API cache and advisory only: the on-chain code length decides deploy-and-donate versus donate.

## Options

`baseUrl` (default: the production server `https://api.endaoment.org`; use the exported `DEV_BASE_URL` or `STAGING_BASE_URL` only for non-production environments), `fetch` (injectable), `cache` (`Cache` implementation, default in-memory, `null` disables), `cacheTtlMs`, `maxRetries`, `retryBaseDelayMs`, `sleep`, `apiKey` (sent as `x-api-key`).

Retries use exponential backoff on network errors and HTTP 408/425/429/5xx, honouring `Retry-After`.

## Org id, cause id and address verification

- `einToOrgId`: the EIN digits without hyphen as ASCII bytes, left-aligned in bytes32 (a hyphenated EIN yields a different, wrong address).
- `uuidToOrgId`: for orgs without an EIN, the Endaoment UUID without hyphens, read as 16 bytes and left-aligned. `toOrgId` picks the rule.
- `toCauseId`: `keccak256(orgId)`.
- `getMainnetDeployment` / `summarizeOrg`: the chain 1 address plus advisory `isDeployed`, and the `isCompliant` and `claimed` flags. Check these before proposing a cause.
- `verifyOrgAddress(publicClient, org)`: compares the derived orgId, through the OrgFundFactory's `computeOrgAddress`, with the API's chain 1 address (`ok` is true on a match). Only write matching orgs to the cause registry. The EIN and UUID rules were checked against the mainnet factory; set `ETH_RPC_URL` to run that check in the test suite.

## Images

Logo and other image URL fields are never declared in the schemas, so they are stripped from all outputs. The client never fetches images.
