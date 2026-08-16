import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { Filter, Hierarchy, QueryResponse, ViewRef, Visual } from "../api/types";
import { validateWells, wellsToQuery, type VisualType } from "./catalog";
import {
  effectiveFilters,
  resolveWells,
  type CrossFilter,
  type DrillState,
} from "./filters";

interface Options {
  reportFilters?: Filter[];
  /** The scope of the page this visual sits on. */
  pageFilters?: Filter[];
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}

/** One query per visual, so tiles render progressively and one slow visual
 *  cannot block the page. Disabled until the wells are actually valid. */
export function useVisualQuery(view: ViewRef, visual: Visual, options: Options = {}) {
  const {
    reportFilters = [],
    pageFilters = [],
    hierarchies = [],
    drill,
    crossFilter = null,
  } = options;
  const type = visual.type as VisualType;

  // Hierarchy references resolve to a single field first: well validation and
  // the query itself both work in terms of real fields, and the query API
  // never sees a hierarchy at all.
  const wells = resolveWells(visual.wells, hierarchies, drill);
  const problems = validateWells(type, wells);
  const ready = problems.length === 0 && Boolean(view.name);
  const { dimensions, metrics } = wellsToQuery(type, wells);
  const filters = effectiveFilters({
    reportFilters,
    pageFilters,
    visual,
    drill,
    crossFilter,
  });

  return {
    problems,
    ready,
    filters,
    /** The wells with hierarchy references already resolved to the level this
     *  visual is currently showing. Callers that need to name that field —
     *  the tile's heading, a cross-filter selection — use this rather than
     *  resolving a second time and risking drift. */
    wells,
    query: useQuery({
      // Everything that changes the RESULT is in the key. Leave any of it out
      // and a filtered tile serves the unfiltered result it cached moments
      // earlier -- which looks like a rendering bug and is not one.
      //
      // `wells` (resolved) rather than `visual.wells`, and `visual.type`
      // rather than the whole visual: renaming a tile must not refetch it.
      queryKey: ["visual-query", view, visual.type, wells, filters],
      enabled: ready,
      queryFn: () =>
        apiFetch<QueryResponse>("/api/query/semantic", {
          method: "POST",
          body: JSON.stringify({
            database: view.database,
            schema: view.schema,
            view: view.name,
            dimensions,
            metrics,
            filters,
          }),
        }),
    }),
  };
}
