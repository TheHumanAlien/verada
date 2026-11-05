"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { loadToken } from "@/lib/data";
import { label } from "@/lib/indexer";
import { readTokenAddress } from "@/lib/token-address";

/** Single client-side page for every token: the address comes from the URL, not the route. */
export function TokenDetail() {
  const config = useAppConfig();
  const deps = useDeps();
  const [address, setAddress] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const read = () => setAddress(readTokenAddress(window.location.search, window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const { data, error, isLoading } = useQuery({
    queryKey: ["token", address],
    queryFn: () => loadToken(config, deps, address as string),
    enabled: Boolean(address),
    retry: false,
  });

  if (address === undefined) return <p role="status">Loading</p>;
  if (address === null) return <p role="alert">Provide a token address, e.g. token/?address=0x...</p>;
  const token = data?.data;

  return (
    <section>
      <h1>{token ? label(token) : address}</h1>
      {isLoading && <p role="status">Loading</p>}
      {error && <p role="alert">Could not load token: {error instanceof Error ? error.message : "unknown error"}</p>}
      {data && !token && <p role="alert">Token not found.</p>}
      {data?.source === "chain" && <p role="note">Indexer unreachable; showing data read directly from the chain.</p>}
      <dl>
        <dt>Address</dt>
        <dd>{address}</dd>
        {token?.creator && (
          <>
            <dt>Creator</dt>
            <dd>{token.creator}</dd>
          </>
        )}
        {token?.feeBps !== undefined && (
          <>
            <dt>Fee (bps)</dt>
            <dd>{token.feeBps}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
