import { apiFetch } from "./client";
import type { Filter, Role } from "./types";

/** One semantic view taking part, under the name this model uses for it. */
export interface CompositeMember {
  alias: string;
  database: string;
  schema: string;
  view: string;
}

/** Where one member keeps a conformed dimension. */
export interface Binding {
  table: string;
  column: string;
}

/**
 * One business concept, and where each member keeps it.
 *
 * `bindings` are the columns that JOIN; `labels` are what a person reads.
 * Keys join, labels display -- a model whose keys are meaningful needs no
 * labels at all.
 */
export interface SharedDimension {
  name: string;
  bindings: Record<string, Binding>;
  labels?: Record<string, Binding>;
}

/** Arithmetic over member metrics, evaluated after each has aggregated. A
 *  closed tree, never an expression string: nothing typed here becomes SQL. */
export type CompositeExpr =
  | { metric: string }
  | { value: number }
  | { op: "+" | "-" | "*" | "/"; left: CompositeExpr; right: CompositeExpr };

export interface DerivedMetric {
  name: string;
  expr: CompositeExpr;
  nullIfDenominatorZero?: boolean;
}

export interface CompositeDefinition {
  schemaVersion: number;
  name: string;
  members: CompositeMember[];
  sharedDimensions: SharedDimension[];
  derivedMetrics: DerivedMetric[];
  /** `full` keeps a customer with tickets and no orders; `inner` keeps only
   *  those present everywhere. */
  joinType: "full" | "inner";
  /** What a filter on one member's own field does to the others. `semi`
   *  narrows them to the keys that survived it; `local` leaves them alone. */
  crossFilter: "semi" | "local";
}

export interface CompositeSummary {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  myRole: Role | "";
  memberCount: number;
  updatedAt: string;
  createdBy: string;
  favorite: boolean;
  lastViewedAt: string | null;
}

export interface CompositeDetail extends CompositeSummary {
  definition: CompositeDefinition;
}

export interface CompositeResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  sfqid: string | null;
  sql: string;
  /** Which member views actually ran. A question touching one costs one. */
  branches: string[];
}

export function listComposites(
  workspaceId?: string,
): Promise<{ composites: CompositeSummary[]; truncated: boolean }> {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  return apiFetch(`/api/composites${query}`);
}

export function getComposite(id: string): Promise<CompositeDetail> {
  return apiFetch(`/api/composites/${id}`);
}

export function createComposite(
  name: string,
  workspaceId?: string,
): Promise<CompositeDetail> {
  return apiFetch("/api/composites", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId }),
  });
}

export function updateComposite(
  id: string,
  definition: CompositeDefinition,
): Promise<CompositeDetail> {
  return apiFetch(`/api/composites/${id}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function deleteComposite(id: string): Promise<void> {
  return apiFetch(`/api/composites/${id}`, { method: "DELETE" });
}

export function importComposite(
  definition: unknown,
  workspaceId?: string,
): Promise<CompositeDetail> {
  return apiFetch("/api/composites/import", {
    method: "POST",
    body: JSON.stringify({ definition, workspaceId }),
  });
}

/**
 * Ask a model a question.
 *
 * A bare name in `dimensions` is a shared dimension and a bare name in
 * `metrics` is a derived metric; `alias:TABLE.FIELD` is one member's own
 * field. Which list a reference sits in separates the two namespaces.
 */
export function queryComposite(
  id: string,
  body: {
    dimensions: string[];
    metrics: string[];
    filters?: Filter[];
    orderBy?: { field: string; direction: "asc" | "desc" }[];
    limit?: number;
  },
): Promise<CompositeResult> {
  return apiFetch(`/api/composites/${id}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
