import { apiFetch } from "./client";
import type { DashboardDetail } from "./dashboards";

export interface RecentItem {
  itemType: "report" | "explore";
  id: string;
  name: string;
  workspaceName: string;
  lastViewedAt: string;
}

/** Which orientation this person needs. Decided on the server so the browser
 *  never has to ask "am I new?", and carried on the Home payload so it costs
 *  no round trip of its own. */
export interface Welcome {
  /** "explore" -- nothing readable yet, so start at a model.
   *  "team"    -- their people already have work here; start by reading it. */
  path: "explore" | "team";
  /** False for a viewer, who cannot act on "build your own report". */
  canAuthor: boolean;
  seen: boolean;
}

export interface HomePayload {
  recent: RecentItem[];
  /** Null covers every way a choice can stop being valid: never made, the
   *  dashboard deleted, the workspace left. All three mean the same thing
   *  to the page, which offers to choose one. */
  dashboard: DashboardDetail | null;
  welcome: Welcome;
}

export function getHome(): Promise<HomePayload> {
  return apiFetch<HomePayload>("/api/home");
}

/** One deliberate interruption at minute zero, and then silence. Reopening
 *  from the profile menu deliberately does not call this: somebody who went
 *  looking for help should not be interrupted again at their next sign-in. */
export function dismissWelcome(): Promise<void> {
  return apiFetch<void>("/api/home/welcome/dismiss", { method: "POST" });
}
