"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppConfig, useDeps } from "@/components/providers";
import { AppLink } from "@/components/nav";
import { loadTokens } from "@/lib/data";
import { label } from "@/lib/indexer";

export function TokenList() {
  const config = useAppConfig();
  const deps = useDeps();
  const { data, error, isLoading } = useQuery({ queryKey: ["tokens"], queryFn: () => loadTokens(config, deps), retry: false });

  return (
    <section>
      <h1>Tokens</h1>
      {isLoading && <p role="status">Loading</p>}
      {error && <p role="alert">Could not load tokens: {error instanceof Error ? error.message : "unknown error"}</p>}
      {data?.source === "chain" && <p role="note">Indexer unreachable; showing data read directly from the chain.</p>}
      {data && data.data.length === 0 && <p>No tokens launched yet.</p>}
      <ul>
        {data?.data.map((t) => (
          <li key={t.address}>
            <AppLink to={`token/?address=${t.address}`}>
              {label(t)}
            </AppLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
