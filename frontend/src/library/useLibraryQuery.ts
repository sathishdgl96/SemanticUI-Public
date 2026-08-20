import { useCallback, useMemo, useState } from "react";
import type { LibraryParams, LibrarySort } from "../api/library";
import type { Facet } from "./FacetChips";

/** The browse state for one list: what is typed, what is filtered, how it is
 *  sorted. Kept out of the page components so the reports and explores lists
 *  cannot drift into browsing differently. */
export function useLibraryQuery(initialRole?: string) {
  const [params, setParams] = useState<LibraryParams>({
    sort: "recent",
    role: initialRole,
  });

  const activeFacets = useMemo<Facet[]>(() => {
    const facets: Facet[] = [];
    if (params.role) facets.push({ key: "role", label: `Role: ${params.role}` });
    if (params.favorite) facets.push({ key: "favorite", label: "Pinned only" });
    if (params.q?.trim()) facets.push({ key: "q", label: `“${params.q.trim()}”` });
    return facets;
  }, [params]);

  const setSearch = useCallback((q: string) => {
    setParams((previous) => ({ ...previous, q }));
  }, []);

  const setSort = useCallback((sort: LibrarySort) => {
    setParams((previous) => ({ ...previous, sort }));
  }, []);

  const setRole = useCallback((role?: string) => {
    setParams((previous) => ({ ...previous, role }));
  }, []);

  const toggleFavoriteFilter = useCallback(() => {
    setParams((previous) => ({ ...previous, favorite: !previous.favorite }));
  }, []);

  const clearFacet = useCallback((key: string) => {
    setParams((previous) => ({
      ...previous,
      role: key === "role" ? undefined : previous.role,
      favorite: key === "favorite" ? false : previous.favorite,
      q: key === "q" ? "" : previous.q,
    }));
  }, []);

  const clearAll = useCallback(() => {
    setParams((previous) => ({ sort: previous.sort }));
  }, []);

  return {
    params,
    activeFacets,
    setSearch,
    setSort,
    setRole,
    toggleFavoriteFilter,
    clearFacet,
    clearAll,
  };
}
