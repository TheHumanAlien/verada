import { createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import type { PrivateRpc } from "./private-rpc";

/**
 * Reads made through wagmi (hooks, receipts, simulations) go through the private RPC,
 * isolated under the connected account. Signing and broadcasting go through the
 * user's wallet and its own RPC, which this app does not control.
 */
export function createWagmiConfig(rpc: PrivateRpc) {
  return createConfig({
    chains: [mainnet],
    // No explicit connectors: wallets are discovered via EIP-6963. Avoids bundling the full connector barrel.
    transports: { [mainnet.id]: rpc.transport() },
  });
}
