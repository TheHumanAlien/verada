"use client";

import { useEffect, useState } from "react";
import { useAppConfig } from "@/components/providers";
import { TokenDetail } from "@/components/token-detail";
import { TokenList } from "@/components/token-list";
import { tokenLabelFromLocation } from "@/lib/host";

/** The label the page is served for (`<label>.<parent>` gateway host or `?label=`); undefined until read. */
export function useTokenLabel(): string | null | undefined {
  const config = useAppConfig();
  const [label, setLabel] = useState<string | null | undefined>(undefined);
  useEffect(() => setLabel(tokenLabelFromLocation(window.location, config.ensParentName)), [config.ensParentName]);
  return label;
}

/** Root page: a token's own page on its ENS name, the token list everywhere else. */
export function HomeRoute() {
  const label = useTokenLabel();
  if (label === undefined) return <p role="status">Loading</p>;
  return label ? <TokenDetail label={label} /> : <TokenList />;
}
