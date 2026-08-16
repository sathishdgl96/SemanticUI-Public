import { apiFetch } from "./client";
import type { AskResponse } from "./types";

export function askReport(reportId: string, question: string): Promise<AskResponse> {
  return apiFetch<AskResponse>(`/api/reports/${encodeURIComponent(reportId)}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}
