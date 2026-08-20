import { ApiError } from "../../api/client";
import type { ViewRef } from "../../api/types";

/** `apiFetch` only ever throws real `ApiError` instances, so `instanceof`
 *  is sound here — no need to duck-type `status`/`code` off an `unknown`. */
export function isMissingView(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.code === "SNOWFLAKE_FORBIDDEN" || error.code === "QUERY_ERROR";
}

export function viewMissingReason(view: ViewRef): string {
  if (view.compositeId) {
    return (
      "Could not open this model. It may have been deleted, or one of the " +
      "views it reads may no longer be readable by your Snowflake role."
    );
  }
  return (
    `Could not open ${view.database}.${view.schema}.${view.name}. It may have been ` +
    "renamed or dropped, or your Snowflake role may no longer have access to it."
  );
}

export function describeUrl(view: ViewRef, refresh = false): string {
  // A model answers a describe of the same shape, so everything that
  // reads a field list -- pickers, wells, filters, chat -- works over one
  // without knowing which it got.
  if (view.compositeId) {
    return `/api/composites/${encodeURIComponent(view.compositeId)}/describe`;
  }
  const base = `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
    view.schema,
  )}/${encodeURIComponent(view.name)}`;
  return refresh ? `${base}?refresh=true` : base;
}

/** Where a query for this source goes. One statement either way; a model
 *  routes to its own planner, which stitches its member views. */
export function queryUrl(view: ViewRef): string {
  return view.compositeId
    ? `/api/composites/${encodeURIComponent(view.compositeId)}/query`
    : "/api/query/semantic";
}

/** Where the filter editor reads a field's distinct values. A model
 *  answers from whichever member owns the field -- values are what a
 *  person picks from, and a conformed dimension means the same thing in
 *  every member, so there is nothing for a join to add. */
export function valuesUrl(view: ViewRef): string {
  return view.compositeId
    ? `/api/composites/${encodeURIComponent(view.compositeId)}/values`
    : `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
        view.schema,
      )}/${encodeURIComponent(view.name)}/values`;
}

/** What to call the source in a sentence. */
export function sourceLabel(view: ViewRef): string {
  if (view.compositeId) return view.name || "a model";
  return `${view.database}.${view.schema}.${view.name}`;
}

/** Why Chat, Excel and Connect are unavailable on a fresh report. Named once
 *  so the three of them cannot drift into three different explanations. */
export const UNBOUND_HINT =
  "Pick a semantic view or a model for this report first — there is no data to work with yet.";
