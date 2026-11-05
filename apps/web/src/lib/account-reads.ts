/**
 * The only sanctioned way to read data keyed by a user's address: portfolio,
 * balances, donations made, votes made. Requests go through the anon network
 * under that account's own isolation key and never fall back to a direct
 * connection, so neither Verada nor the RPC provider can tie the query to the
 * user's IP or to the user's other accounts.
 *
 * Do NOT send a user's address to the Verada indexer. Read account data from the
 * chain with this client, or fetch public data and filter it in the browser.
 */
import { createPublicClient, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import type { PrivateRpc } from "./private-rpc";

export function createAccountClient(rpc: PrivateRpc, account: Address): PublicClient {
  return createPublicClient({ chain: mainnet, transport: rpc.transport({ kind: "account", address: account }) }) as PublicClient;
}
