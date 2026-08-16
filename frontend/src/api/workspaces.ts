import { apiFetch } from "./client";
import type { ReportDetail, Role, WorkspaceMember, WorkspaceSummary } from "./types";

/** Mirrors ROLES in backend/app/workspaces/roles.py. Weakest first; the index
 *  is the rank. Kept in the same order so the two cannot drift apart. */
const ROLES: Role[] = ["viewer", "editor", "admin"];

/** Fails closed on anything unrecognised, matching `at_least` on the server:
 *  a garbage role satisfies nothing rather than sorting above every real one
 *  the way a naive string comparison would. */
export function atLeast(actual: Role, need: Role): boolean {
  const a = ROLES.indexOf(actual);
  const n = ROLES.indexOf(need);
  return a >= 0 && n >= 0 && a >= n;
}

const ws = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

export function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return apiFetch<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
}

export function createWorkspace(name: string): Promise<WorkspaceSummary> {
  return apiFetch<WorkspaceSummary>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary> {
  return apiFetch<WorkspaceSummary>(ws(id), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiFetch<void>(ws(id), { method: "DELETE" });
}

export function listMembers(id: string): Promise<{ members: WorkspaceMember[] }> {
  return apiFetch<{ members: WorkspaceMember[] }>(`${ws(id)}/members`);
}

export function addMember(
  id: string,
  snowflakeUser: string,
  role: Role,
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(`${ws(id)}/members`, {
    method: "POST",
    body: JSON.stringify({ snowflakeUser, role }),
  });
}

export function setMemberRole(
  id: string,
  userId: string,
  role: Role,
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(`${ws(id)}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeMember(id: string, userId: string): Promise<void> {
  return apiFetch<void>(`${ws(id)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export function moveReport(
  reportId: string,
  workspaceId: string,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(reportId)}/move`, {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}
