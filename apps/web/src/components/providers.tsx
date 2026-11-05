"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { loadRuntimeConfig, type AppConfig } from "@/lib/config";
import { createDeps, type DataDeps } from "@/lib/data";
import { createWagmiConfig } from "@/lib/wagmi";

interface Runtime {
  config: AppConfig;
  deps: DataDeps;
}

const RuntimeContext = createContext<Runtime | null>(null);

export function useAppConfig(): AppConfig {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useAppConfig must be used inside <Providers>");
  return ctx.config;
}

export function useDeps(): DataDeps {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useDeps must be used inside <Providers>");
  return ctx.deps;
}

/** Loads /config.json once at startup, then mounts wagmi and react-query with it. */
export function Providers({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => {
    let live = true;
    void loadRuntimeConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);

  const runtime = useMemo(() => (config ? { config, deps: createDeps(config) } : null), [config]);
  const wagmiConfig = useMemo(() => (config ? createWagmiConfig(config) : null), [config]);

  if (!runtime || !wagmiConfig) return <p role="status">Loading configuration</p>;
  return (
    <RuntimeContext.Provider value={runtime}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    </RuntimeContext.Provider>
  );
}
