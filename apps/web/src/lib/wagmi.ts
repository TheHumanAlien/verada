import { createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import type { AppConfig } from "./config";

export function createWagmiConfig(cfg: AppConfig) {
  return createConfig({
    chains: [mainnet],
    // No explicit connectors: wallets are discovered via EIP-6963. Avoids bundling the full connector barrel.
    transports: { [mainnet.id]: http(cfg.rpcUrl) },
  });
}
