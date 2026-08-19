import { ApiError } from "../../api/client";
import type { ViewRef } from "../../api/types";

/** `apiFetch` only ever throws real `ApiError` instances, so `instanceof`
 *  is sound here — no need to duck-type `status`/`code` off an `unknown`. */
export function isMissingView(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.code === "SNOWFLAKE_FORBIDDEN" || error.code === "QUERY_ERROR";
}

export function viewMissingReason(view: ViewRef): string {
  return (
    `Could not open ${view.database}.${view.schema}.${view.name}. It may have been ` +
    "renamed or dropped, or your Snowflake role may no longer have access to it."
  );
}

export function describeUrl(view: ViewRef, refresh = false): string {
  const base = `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
    view.schema,
  )}/${encodeURIComponent(view.name)}`;
  return refresh ? `${base}?refresh=true` : base;
}

/** Why Chat, Excel and Connect are unavailable on a fresh report. Named once
 *  so the three of them cannot drift into three different explanations. */
export const UNBOUND_HINT =
  "Pick a semantic view for this report first — there is no data to work with yet.";
