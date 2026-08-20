import { apiFetch } from "./client";
import type { Filter, Hierarchy, ViewRef, Visual, VisualLayout } from "./types";
import type { Role } from "./types";

/** A tile the server could resolve: everything needed to draw it. */
export interface LiveTile {
  id: string;
  reportId: string;
  pageId: string;
  visualId: string;
  layout: VisualLayout;
  title: string | null;
  available: true;
  reportName: string;
  view: ViewRef;
  visual: Visual;
  /** The report's and page's own scopes. They travel with the visual, or a
   *  tile would show a different number from the report it came from. */
  reportFilters: Filter[];
  pageFilters: Filter[];
  hierarchies: Hierarchy[];
}

/** A tile whose report or visual is gone, or is no longer readable. Not an
 *  error: a tile with nothing behind it any more. */
export interface DeadTile {
  id: string;
  reportId: string;
  pageId: string;
  visualId: string;
  layout: VisualLayout;
  title: string | null;
  available: false;
  reason: string;
  reportName?: string;
}

export type DashboardTile = LiveTile | DeadTile;

export interface DashboardSummary {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  myRole: Role;
  tileCount: number;
  updatedAt: string | null;
  /** Pinned by THIS caller, and when they last opened it -- the same
   *  browse state reports and explores carry, so one list can hold all
   *  three kinds and sort them together. */
  favorite: boolean;
  lastViewedAt: string | null;
  /** Who created it. Provenance, never permission (ADR 0009). */
  createdBy?: string;
}

export type DashboardDetail = DashboardSummary & { tiles: DashboardTile[] };

/** What a tile stores, as opposed to what the server resolves it into. */
export interface TileRef {
  id: string;
  reportId: string;
  pageId: string;
  visualId: string;
  title: string | null;
  layout: VisualLayout;
}

export interface DashboardDefinition {
  schemaVersion: number;
  name: string;
  tiles: TileRef[];
}

export function listDashboards(workspaceId?: string): Promise<{
  dashboards: DashboardSummary[];
}> {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  return apiFetch(`/api/dashboards${query}`);
}

export function createDashboard(
  name: string,
  workspaceId?: string,
): Promise<DashboardDetail> {
  return apiFetch("/api/dashboards", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId: workspaceId ?? null }),
  });
}

export function getDashboard(id: string): Promise<DashboardDetail> {
  return apiFetch(`/api/dashboards/${encodeURIComponent(id)}`);
}

export function updateDashboard(
  id: string,
  definition: DashboardDefinition,
): Promise<DashboardDetail> {
  return apiFetch(`/api/dashboards/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function deleteDashboard(id: string): Promise<void> {
  return apiFetch(`/api/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function addTile(
  dashboardId: string,
  tile: { reportId: string; pageId: string; visualId: string; title?: string },
): Promise<DashboardTile> {
  return apiFetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/tiles`, {
    method: "POST",
    body: JSON.stringify(tile),
  });
}

export function removeTile(dashboardId: string, tileId: string): Promise<void> {
  return apiFetch(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}`,
    { method: "DELETE" },
  );
}

/** Which dashboard this user opens on Home. Null clears the choice. */
export function setHomeDashboard(dashboardId: string | null): Promise<{
  dashboardId: string | null;
}> {
  return apiFetch("/api/home/dashboard", {
    method: "PUT",
    body: JSON.stringify({ dashboardId }),
  });
}
