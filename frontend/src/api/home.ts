import { apiFetch } from "./client";
import type { Filter, Hierarchy, ViewRef, Visual, VisualLayout } from "./types";

export interface RecentItem {
  itemType: "report" | "explore";
  id: string;
  name: string;
  workspaceName: string;
  lastViewedAt: string;
}

/** A widget the server could resolve: everything a tile needs to draw. */
export interface LiveWidget {
  id: string;
  reportId: string;
  pageId: string;
  visualId: string;
  layout: VisualLayout;
  title: string | null;
  available: true;
  reportName: string;
  workspaceName: string;
  myRole: string;
  view: ViewRef;
  visual: Visual;
  /** The report's and page's own scopes. They travel with the visual, or a
   *  pinned tile would show a different number from the report it came
   *  from. */
  reportFilters: Filter[];
  pageFilters: Filter[];
  hierarchies: Hierarchy[];
}

/** A widget whose report or visual is gone, or is no longer this user's to
 *  read. Not an error: a tile with nothing behind it any more. */
export interface DeadWidget {
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

export type HomeWidget = LiveWidget | DeadWidget;

export interface HomePayload {
  recent: RecentItem[];
  widgets: HomeWidget[];
}

export function getHome(): Promise<HomePayload> {
  return apiFetch<HomePayload>("/api/home");
}

export function pinVisual(body: {
  reportId: string;
  pageId: string;
  visualId: string;
  title?: string;
}): Promise<HomeWidget> {
  return apiFetch<HomeWidget>("/api/home/widgets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function unpinWidget(widgetId: string): Promise<void> {
  return apiFetch<void>(`/api/home/widgets/${encodeURIComponent(widgetId)}`, {
    method: "DELETE",
  });
}

export function rearrangeWidgets(
  layouts: { id: string; x: number; y: number; w: number; h: number }[],
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/home/widgets", {
    method: "PATCH",
    body: JSON.stringify({ layouts }),
  });
}
