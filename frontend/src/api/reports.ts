import { apiFetch } from "./client";
import { libraryQueryString, type LibraryParams } from "./library";
import type { ReportDefinition, ReportDetail, ReportSummary, ViewRef } from "./types";

export function listReports(
  workspaceId?: string,
  params: LibraryParams = {},
): Promise<{ reports: ReportSummary[]; truncated?: boolean }> {
  const browse = libraryQueryString(params);
  // The workspace joins whatever the browse controls already asked for,
  // so it is "&" once anything else is there and "?" when it is first.
  const scope = workspaceId
    ? `${browse ? `${browse}&` : "?"}workspace=${encodeURIComponent(workspaceId)}`
    : browse;
  return apiFetch<{ reports: ReportSummary[]; truncated?: boolean }>(`/api/reports${scope}`);
}

export function getReport(id: string): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
}

export function createReport(
  definition: ReportDefinition,
  workspaceId?: string,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports", {
    method: "POST",
    // Omitted workspaceId means "my personal workspace", which is what a
    // plain "New report" should do.
    body: JSON.stringify({ definition, workspaceId }),
  });
}

export function updateReport(
  id: string,
  definition: ReportDefinition,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function deleteReport(id: string): Promise<void> {
  return apiFetch<void>(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Returns the raw portable document text, not a parsed object — the point is
 *  to hand the user something byte-identical to copy. */
export async function exportReport(id: string): Promise<string> {
  const response = await fetch(`/api/reports/${encodeURIComponent(id)}/export`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Export failed");
  return response.text();
}

export function importReport(
  definition: unknown,
  viewOverride?: ViewRef,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports/import", {
    method: "POST",
    body: JSON.stringify({ definition, viewOverride: viewOverride ?? null }),
  });
}
