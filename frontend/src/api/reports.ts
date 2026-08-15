import { apiFetch } from "./client";
import type { ReportDefinition, ReportDetail, ReportSummary, ViewRef } from "./types";

export function listReports(): Promise<{ reports: ReportSummary[] }> {
  return apiFetch<{ reports: ReportSummary[] }>("/api/reports");
}

export function getReport(id: string): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
}

export function createReport(definition: ReportDefinition): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ definition }),
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
