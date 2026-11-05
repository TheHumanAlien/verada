import { isAddress } from "viem";

/** Reads the token address from `?address=` (or `?a=`), falling back to the URL hash. */
export function readTokenAddress(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const candidate = params.get("address") ?? params.get("a") ?? hash.replace(/^#/, "");
  return isAddress(candidate) ? candidate : null;
}
