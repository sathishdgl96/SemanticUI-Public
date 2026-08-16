import { apiFetch } from "./client";
import type { ExploreDefinition, ExploreDetail, ExploreSummary } from "./types";

export function listExplores(workspaceId?: string) {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  return apiFetch<{ explores: ExploreSummary[] }>(`/api/explores${query}`);
}

export function getExplore(id: string) {
  return apiFetch<ExploreDetail>(`/api/explores/${encodeURIComponent(id)}`);
}

export function createExplore(definition: ExploreDefinition, workspaceId?: string) {
  return apiFetch<ExploreDetail>("/api/explores", {
    method: "POST",
    body: JSON.stringify({ definition, workspaceId }),
  });
}

export function updateExplore(id: string, definition: ExploreDefinition) {
  return apiFetch<ExploreDetail>(`/api/explores/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function deleteExplore(id: string) {
  return apiFetch<void>(`/api/explores/${encodeURIComponent(id)}`, { method: "DELETE" });
}
