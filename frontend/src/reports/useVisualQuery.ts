import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { Filter, Hierarchy, QueryResponse, ViewRef, Visual } from "../api/types";
import {
  DEFAULT_AGGREGATION,
  validateWells,
  wellsToQuery,
  type VisualType,
} from "./catalog";
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
  /** Filters contributed by on-canvas slicers. */
  slicerFilters?: Filter[];
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
  /** Set false for visual types that draw without a semantic query. */
  enabled?: boolean;
  /** Refs the view exposes as raw FACTS. A measure-well entry that names one
   *  is aggregated ad hoc rather than sent as a governed metric. */
  factRefs?: string[];
}

/** Split the measure-well refs into the view's own metrics and the raw facts
 *  that need an aggregation applied.
 *
 *  A fact and a metric are measured at different grains, so the query API
 *  refuses to take both at once -- the partition here is what keeps a visual
 *  from asking for that combination in the first place. */
export function splitMeasures(
  measures: string[],
  factRefs: string[],
  aggregations: Record<string, string> | undefined,
): { metrics: string[]; aggregations: { field: string; fn: string }[] } {
  const facts = new Set(factRefs.map((r) => r.toUpperCase()));
  const metrics: string[] = [];
  const aggregated: { field: string; fn: string }[] = [];
  for (const ref of measures) {
    if (facts.has(ref.toUpperCase())) {
      aggregated.push({ field: ref, fn: aggregations?.[ref] ?? DEFAULT_AGGREGATION });
    } else {
      metrics.push(ref);
    }
  }
  return { metrics, aggregations: aggregated };
}

/** One query per visual, so tiles render progressively and one slow visual
 *  cannot block the page. Disabled until the wells are actually valid. */
export function useVisualQuery(view: ViewRef, visual: Visual, options: Options = {}) {
  const {
    reportFilters = [],
    pageFilters = [],
    slicerFilters = [],
    hierarchies = [],
    drill,
    crossFilter = null,
    enabled = true,
    factRefs = [],
  } = options;
  const type = visual.type as VisualType;

  // Hierarchy references resolve to a single field first: well validation and
  // the query itself both work in terms of real fields, and the query API
  // never sees a hierarchy at all.
  const wells = resolveWells(visual.wells, hierarchies, drill);
  const problems = validateWells(type, wells);
  const ready = enabled && problems.length === 0 && Boolean(view.name);
  const { dimensions, metrics: measures } = wellsToQuery(type, wells);
  const { metrics, aggregations } = splitMeasures(
    measures,
    factRefs,
    visual.options.aggregations as Record<string, string> | undefined,
  );
  const filters = effectiveFilters({
    reportFilters,
    pageFilters,
    slicerFilters,
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
      // `aggregations` is in the key: changing Sum to Average changes the
      // RESULT, and leaving it out would serve the previous function's
      // numbers under the new label.
      queryKey: ["visual-query", view, visual.type, wells, filters, aggregations],
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
            aggregations,
            filters,
          }),
        }),
    }),
  };
}
