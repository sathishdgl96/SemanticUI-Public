import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { FieldValuesResponse, ViewRef } from "../api/types";

/** What a picker shows at once. Mirrors VALUES_PAGE on the server, which is
 *  what actually decides -- this is the number we ask for. */
export const VALUES_PAGE = 10;

/** Distinct values of one dimension, for a value picker.
 *
 *  Runs on the caller's own Snowflake connection, so a user is only ever
 *  offered values their role can already read. Pass `field = null` for an
 *  operator that takes no values — the query then never runs.
 *
 *  `search` is sent to the server rather than applied to the result, because
 *  the result is one page: filtering a page of ten would only ever find what
 *  is already on screen.
 */
export function useFieldValues(
  view: ViewRef,
  field: string | null,
  options: { search?: string; limit?: number } = {},
) {
  const { search = "", limit = VALUES_PAGE } = options;
  return useQuery({
    queryKey: ["field-values", view, field, search, limit],
    enabled: Boolean(view.name && field),
    // Values change far more slowly than a picker opens and closes, and every
    // fetch is a real Snowflake query. Caching per search term also means
    // backspacing through what you typed costs nothing.
    staleTime: 5 * 60 * 1000,
    // The previous page stays on screen while the next one loads, so typing
    // does not make the list flicker empty between keystrokes.
    placeholderData: (previous) => previous,
    queryFn: () => {
      const base = `/api/semantic-views/${encodeURIComponent(
        view.database,
      )}/${encodeURIComponent(view.schema)}/${encodeURIComponent(view.name)}/values`;
      const params = new URLSearchParams({ field: field ?? "", limit: String(limit) });
      if (search) params.set("search", search);
      return apiFetch<FieldValuesResponse>(`${base}?${params}`);
    },
  });
}

/** `value`, but only after it has stopped changing for `ms`.
 *
 *  Every distinct search term is a Snowflake round trip, so the query follows
 *  the pause rather than the keystroke. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
