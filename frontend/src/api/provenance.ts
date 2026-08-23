import { apiFetch } from "./client";
import type { ViewRef } from "./types";

/** One base table under the semantic view, and what we can honestly say
 *  about how current it is. `state` is the whole vocabulary:
 *
 *  - `updated`         data changed more recently than the definition
 *  - `definition-only` only the definition has moved; no data timestamp
 *  - `not-visible`     the caller's Snowflake role cannot see the table
 *  - `query-backed`    a logical table defined by SQL, with no one source
 *  - `unresolved`      the model named no base table for it
 */
export interface FreshnessRow {
  name: string;
  source: string | null;
  state:
    | "updated"
    | "definition-only"
    | "not-visible"
    | "query-backed"
    | "unresolved";
  at: string | null;
  isDynamic: boolean;
  rowCount: number | null;
}

export interface Freshness {
  tables: FreshnessRow[];
  /** The stalest source, because a report is only as current as its oldest
   *  input. Null when nothing resolved to a data timestamp. */
  oldest: string | null;
  /** False the moment any table is not covered by `oldest`, so one number
   *  is never allowed to stand for a partial answer. */
  complete: boolean;
  /** False when the freshness query itself failed -- a stopped warehouse is
   *  the ordinary case, and the rest of the page still has to render. */
  available: boolean;
  /** Why, in Snowflake's own words, when it failed. Null when it did not.
   *  A failure that only says "could not be run" is a dead end for whoever
   *  has to fix it. */
  reason: string | null;
}

export interface ModelTrust {
  database: string;
  schema: string;
  name: string;
  certified: boolean;
  owner: { name: string | null; contact: string | null };
  /** Present only while the claim is live. Clearing certification keeps the
   *  owner but must not keep a timestamp that reads as an endorsement. */
  certifiedBy: { role: string; at: string } | null;
  note: string | null;
}

export interface Provenance {
  model: ModelTrust;
  freshness: Freshness;
  lineage: { available: false; placeholder: string };
  openIssues: {
    available: false;
    columns: string[];
    issues: unknown[];
    placeholder: string;
  };
}

export interface Certification {
  certified: boolean;
  owner: { name: string | null; contact: string | null };
  certifiedBy: { role: string; at: string } | null;
  note: string | null;
  /** Whether Snowflake says this session holds the role that owns the view.
   *  The only thing that should decide whether the UI offers the control. */
  canCertify: boolean;
}

export function getProvenance(reportId: string): Promise<Provenance> {
  return apiFetch<Provenance>(
    `/api/reports/${encodeURIComponent(reportId)}/provenance`,
  );
}

function certificationPath(view: ViewRef): string {
  return `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
    view.schema,
  )}/${encodeURIComponent(view.name)}/certification`;
}

export function getCertification(view: ViewRef): Promise<Certification> {
  return apiFetch<Certification>(certificationPath(view));
}

export function putCertification(
  view: ViewRef,
  body: {
    certified: boolean;
    ownerName: string | null;
    ownerContact: string | null;
    note: string | null;
  },
): Promise<Certification> {
  return apiFetch<Certification>(certificationPath(view), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
