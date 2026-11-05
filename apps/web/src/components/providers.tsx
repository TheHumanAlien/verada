"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount, WagmiProvider } from "wagmi";
import { loadRuntimeConfig, type AppConfig } from "@/lib/config";
import { createDeps, type DataDeps } from "@/lib/data";
import { PrivateRpc } from "@/lib/private-rpc";
import { readPrivacyPrefs, writePrivacyPrefs, type PrivacyPrefs } from "@/lib/privacy-prefs";
import { createWagmiConfig } from "@/lib/wagmi";

interface Runtime {
  config: AppConfig;
  deps: DataDeps;
  rpc: PrivateRpc;
  prefs: PrivacyPrefs;
  setPrefs(p: PrivacyPrefs): void;
}

const RuntimeContext = createContext<Runtime | null>(null);

function useRuntime(hook: string): Runtime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error(`${hook} must be used inside <Providers>`);
  return ctx;
}

export function useAppConfig(): AppConfig {
  return useRuntime("useAppConfig").config;
}

export function useDeps(): DataDeps {
  return useRuntime("useDeps").deps;
}

export function usePrivateRpc(): PrivateRpc {
  return useRuntime("usePrivateRpc").rpc;
}

export function usePrivacyPrefs(): [PrivacyPrefs, (p: PrivacyPrefs) => void] {
  const { prefs, setPrefs } = useRuntime("usePrivacyPrefs");
  return [prefs, setPrefs];
}

/** Keeps the private RPC's isolation key in step with the connected wallet. */
function AccountIsolation({ rpc }: { rpc: PrivateRpc }) {
  const { address } = useAccount();
  useEffect(() => rpc.setAccount(address), [rpc, address]);
  return null;
}

/** Loads /config.json once at startup, then mounts wagmi and react-query with it. */
export function Providers({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [queryClient] = useState(() => new QueryClient());
  const [prefs, setPrefsState] = useState<PrivacyPrefs>(() => readPrivacyPrefs());
  // Read by the indexer client on every request, so a toggle applies without rebuilding deps.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    let live = true;
    void loadRuntimeConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);

  const rpc = useMemo(() => (config ? new PrivateRpc(config.privateRpc) : null), [config]);
  useEffect(() => () => rpc?.close(), [rpc]);

  const base = useMemo(
    () => (config && rpc ? { config, rpc, deps: createDeps(config, rpc, () => prefsRef.current.routeIndexer) } : null),
    [config, rpc],
  );
  const wagmiConfig = useMemo(() => (rpc ? createWagmiConfig(rpc) : null), [rpc]);
  const runtime = useMemo<Runtime | null>(
    () =>
      base && {
        ...base,
        prefs,
        setPrefs: (p) => {
          writePrivacyPrefs(p);
          setPrefsState(p);
        },
      },
    [base, prefs],
  );

  if (!runtime || !wagmiConfig) return <p role="status">Loading configuration</p>;
  return (
    <RuntimeContext.Provider value={runtime}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <AccountIsolation rpc={runtime.rpc} />
          {children}
        </QueryClientProvider>
      </WagmiProvider>
    </RuntimeContext.Provider>
  );
}
