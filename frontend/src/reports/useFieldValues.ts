import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { FieldValuesResponse, ViewRef } from "../api/types";

/** Distinct values of one dimension, for the filter editor's value picker.
 *
 *  Runs on the caller's own Snowflake connection, so a user is only ever
 *  offered values their role can already read. Pass `field = null` for an
 *  operator that takes no values — the query then never runs. */
export function useFieldValues(view: ViewRef, field: string | null) {
  return useQuery({
    queryKey: ["field-values", view, field],
    enabled: Boolean(view.name && field),
    // Values change far more slowly than the filter editor opens and closes,
    // and every fetch is a real Snowflake query.
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const base = `/api/semantic-views/${encodeURIComponent(
        view.database,
      )}/${encodeURIComponent(view.schema)}/${encodeURIComponent(view.name)}/values`;
      return apiFetch<FieldValuesResponse>(
        `${base}?field=${encodeURIComponent(field ?? "")}`,
      );
    },
  });
}
