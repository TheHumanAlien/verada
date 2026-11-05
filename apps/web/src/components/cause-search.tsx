"use client";

import { useState, type FormEvent } from "react";
import { useDeps } from "@/components/providers";
import type { CauseSummary } from "@/lib/indexer";

/** Nonprofit search. With `onSelect`, each result gets a button that hands it to the caller. */
export function CauseSearch({ onSelect, selectLabel = "Add" }: { onSelect?(cause: CauseSummary): void; selectLabel?: string } = {}) {
  const deps = useDeps();
  const [query, setQuery] = useState("");
  const [causes, setCauses] = useState<CauseSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  async function run(cursorArg?: string) {
    setError(undefined);
    try {
      const page = await deps.indexer.searchCauses(query.trim(), cursorArg);
      setCauses((prev) => (cursorArg && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setCauses(null);
      setCursor(null);
      setError(err instanceof Error ? err.message : "Search failed");
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run();
  }

  return (
    <div>
      <form onSubmit={onSubmit} role="search">
        <label>
          Search nonprofits <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>{" "}
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {causes && causes.length === 0 && <p>No results.</p>}
      {causes && (
        <ul>
          {causes.map((c) => (
            <li key={c.causeId}>
              {c.name} ({c.isDeployed ? "deployed" : "not yet deployed"})
              {c.address && <code> {c.address}</code>}
              {onSelect && (
                <>
                  {" "}
                  <button type="button" onClick={() => onSelect(c)}>
                    {selectLabel} {c.name}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" onClick={() => void run(cursor)}>
          Load more
        </button>
      )}
    </div>
  );
}
