"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { CATEGORIES, REGIONS } from "@verada/sdk";
import { useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import type { CatalogOrg } from "@/lib/indexer";

const PAGE = 20;

export const categoryLabel = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
export const regionLabel = (slug: string) => REGIONS.find((r) => r.slug === slug)?.label ?? slug;

/** Names of catalogue orgs by cause id (lowercase), for ballots whose options are not in the registry yet. */
export function useCatalogNames(causeIds: readonly string[]) {
  const deps = useDeps();
  const ids = [...new Set(causeIds.map((c) => c.toLowerCase()))].sort();
  return useQuery({
    queryKey: ["catalog-names", ids.join(",")],
    queryFn: () => deps.indexer.catalogCauses(ids),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 600_000,
  });
}

function Checklist({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: readonly { slug: string; label: string }[];
  selected: string[];
  onChange(next: string[]): void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.slug} style={{ marginRight: "1em", whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={selected.includes(o.slug)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.slug] : selected.filter((s) => s !== o.slug))}
          />{" "}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Category and region pickers. An empty list means "any". */
export function FocusPicker({
  categories,
  regions,
  onChange,
  only,
}: {
  categories: string[];
  regions: string[];
  onChange(next: { categories: string[]; regions: string[] }): void;
  /** Restrict the choices (for example to a token's focus). */
  only?: { categories: string[]; regions: string[] };
}) {
  const cats = only?.categories.length ? CATEGORIES.filter((c) => only.categories.includes(c.slug)) : CATEGORIES;
  const regs = only?.regions.length ? REGIONS.filter((r) => only.regions.includes(r.slug)) : REGIONS;
  return (
    <>
      <Checklist legend="Causes (none ticked: any)" options={cats} selected={categories} onChange={(c) => onChange({ categories: c, regions })} />
      <Checklist legend="Regions (none ticked: any)" options={regs} selected={regions} onChange={(r) => onChange({ categories, regions: r })} />
    </>
  );
}

/**
 * Browses the cause catalogue by name, category and region. With `onSelect` each result gets a
 * button; `within` limits the browse to a token's focus.
 */
export function CatalogBrowser({
  onSelect,
  selectLabel = "Add",
  within,
}: {
  onSelect?(org: CatalogOrg): void;
  selectLabel?: string;
  within?: { categories: string[]; regions: string[] };
}) {
  const deps = useDeps();
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<{ categories: string[]; regions: string[] }>({ categories: [], regions: [] });
  const [submitted, setSubmitted] = useState<{ q: string; categories: string[]; regions: string[]; offset: number } | null>(null);

  const scope = (f: { categories: string[]; regions: string[] }) => ({
    categories: f.categories.length ? f.categories : (within?.categories ?? []),
    regions: f.regions.length ? f.regions : (within?.regions ?? []),
  });

  const results = useQuery({
    queryKey: ["catalog-search", submitted],
    queryFn: () => deps.indexer.catalogSearch({ q: submitted!.q, ...scope(submitted!), offset: submitted!.offset, limit: PAGE }),
    enabled: submitted !== null,
    retry: false,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted({ q: query.trim(), ...focus, offset: 0 });
  }

  const page = results.data;
  return (
    <div>
      <form onSubmit={onSubmit} role="search" aria-label="Browse the cause catalogue">
        <label>
          Name <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <FocusPicker categories={focus.categories} regions={focus.regions} onChange={setFocus} only={within} />
        <button type="submit">Browse</button>
      </form>
      {results.isLoading && <p role="status">Searching the catalogue</p>}
      {results.error && <p role="alert">Catalogue search failed: {errorText(results.error)}</p>}
      {submitted && page === null && <p role="alert">The cause catalogue is not available on this indexer.</p>}
      {page && (
        <>
          <p>
            {page.total} organization{page.total === 1 ? "" : "s"}
          </p>
          <ul>
            {page.items.map((o) => (
              <li key={o.causeId}>
                {o.name}
                {o.country ? ` (${o.country})` : ""} {o.categories.map(categoryLabel).join(", ")}
                {onSelect && (
                  <>
                    {" "}
                    <button type="button" onClick={() => onSelect(o)}>
                      {selectLabel} {o.name}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {submitted && submitted.offset + PAGE < page.total && (
            <button type="button" onClick={() => setSubmitted({ ...submitted, offset: submitted.offset + PAGE })}>
              Next page
            </button>
          )}
        </>
      )}
    </div>
  );
}
