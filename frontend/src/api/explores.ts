import { apiFetch } from "./client";
import { libraryQueryString, type LibraryParams } from "./library";
import type { ExploreDefinition, ExploreDetail, ExploreSummary } from "./types";

export function listExplores(workspaceId?: string, params: LibraryParams = {}) {
  const browse = libraryQueryString(params);
  const scope = workspaceId
    ? `${browse ? `${browse}&` : "?"}workspace=${encodeURIComponent(workspaceId)}`
    : browse;
  return apiFetch<{ explores: ExploreSummary[] }>(`/api/explores${scope}`);
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
