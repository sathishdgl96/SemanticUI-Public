import { apiFetch } from "./client";
import type { DashboardDetail } from "./dashboards";

export interface RecentItem {
  itemType: "report" | "explore";
  id: string;
  name: string;
  workspaceName: string;
  lastViewedAt: string;
}

export interface HomePayload {
  recent: RecentItem[];
  /** Null covers every way a choice can stop being valid: never made, the
   *  dashboard deleted, the workspace left. All three mean the same thing
   *  to the page, which offers to choose one. */
  dashboard: DashboardDetail | null;
}

export function getHome(): Promise<HomePayload> {
  return apiFetch<HomePayload>("/api/home");
}
