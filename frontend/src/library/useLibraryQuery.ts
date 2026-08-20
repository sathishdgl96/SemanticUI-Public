import { useCallback, useMemo, useState } from "react";
import type { LibraryParams, LibrarySort } from "../api/library";
import type { Facet } from "./FacetChips";

/** Which kind of thing a workspace list is showing. A filter rather than
 *  three menus: reports, dashboards and explores all live in a workspace
 *  and are browsed the same way, so what separates them is a control on
 *  one page, not a page each. */
export type ItemFilter = "all" | "report" | "dashboard" | "explore";

export const ITEM_FILTERS: { value: ItemFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "report", label: "Reports" },
  { value: "dashboard", label: "Dashboards" },
  { value: "explore", label: "Explores" },
];

/** The browse state for one list: what is typed, what is filtered, how it is
 *  sorted. Kept out of the page components so the reports and explores lists
 *  cannot drift into browsing differently. */
export function useLibraryQuery(initialRole?: string) {
  const [params, setParams] = useState<LibraryParams>({
    sort: "recent",
    role: initialRole,
  });
  const [kind, setKind] = useState<ItemFilter>("all");

  const activeFacets = useMemo<Facet[]>(() => {
    const facets: Facet[] = [];
    if (kind !== "all") {
      facets.push({
        key: "kind",
        label: ITEM_FILTERS.find((f) => f.value === kind)?.label ?? kind,
      });
    }
    if (params.role) facets.push({ key: "role", label: `Role: ${params.role}` });
    if (params.favorite) facets.push({ key: "favorite", label: "Pinned only" });
    if (params.q?.trim()) facets.push({ key: "q", label: `“${params.q.trim()}”` });
    return facets;
  }, [params, kind]);

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
    if (key === "kind") setKind("all");
    setParams((previous) => ({
      ...previous,
      role: key === "role" ? undefined : previous.role,
      favorite: key === "favorite" ? false : previous.favorite,
      q: key === "q" ? "" : previous.q,
    }));
  }, []);

  const clearAll = useCallback(() => {
    setKind("all");
    setParams((previous) => ({ sort: previous.sort }));
  }, []);

  return {
    params,
    kind,
    setKind,
    activeFacets,
    setSearch,
    setSort,
    setRole,
    toggleFavoriteFilter,
    clearFacet,
    clearAll,
  };
}
