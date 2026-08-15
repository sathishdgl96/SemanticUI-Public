import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { QueryResponse, ViewRef, Visual } from "../api/types";
import { validateWells, wellsToQuery, type VisualType } from "./catalog";

/** One query per visual, so tiles render progressively and one slow visual
 *  cannot block the page. Disabled until the wells are actually valid. */
export function useVisualQuery(view: ViewRef, visual: Visual) {
  const type = visual.type as VisualType;
  const problems = validateWells(type, visual.wells);
  const ready = problems.length === 0 && Boolean(view.name);
  const { dimensions, metrics } = wellsToQuery(type, visual.wells);

  return {
    problems,
    ready,
    query: useQuery({
      queryKey: ["visual-query", view, visual.type, visual.wells],
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
          }),
        }),
    }),
  };
}
