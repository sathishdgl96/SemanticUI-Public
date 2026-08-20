import { apiFetch } from "./client";

export interface HealthCheck {
  name: string;
  status: "ok" | "down";
  latencyMs: number | null;
  detail: string;
}

export interface Health {
  status: "ok" | "down";
  uptimeSeconds: number;
  checks: HealthCheck[];
  counts: Record<string, number>;
}

export interface AuditEvent {
  id: string;
  ts: string;
  action: string;
  outcome: string;
  user: string;
  requestId: string | null;
  sessionRef: string | null;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
}

export interface EventPage {
  events: AuditEvent[];
  /** The cursor for the next page, or null when this was the last. */
  nextBefore: string | null;
  /** Every action the trail actually holds, so the filter offers what is
   *  there rather than a list written months ago. */
  actions: string[];
}

export interface Alert {
  id: string;
  severity: "ok" | "info" | "medium" | "high";
  title: string;
  count: number;
  detail: string;
}

export interface Security {
  windowHours: number;
  alerts: Alert[];
  recentDenials: {
    id: string;
    ts: string;
    action: string;
    outcome: string;
    user: string;
    resourceType: string | null;
    requestId: string | null;
  }[];
  activity: { hour: string; count: number }[];
}

export interface EventQuery {
  action?: string;
  outcome?: string;
  user?: string;
  hours?: number;
  before?: string;
  limit?: number;
}

/** Whether to draw the admin entry at all. Answered for everyone, so an
 *  ordinary page load does not produce an audited denial. */
export function amIAppAdmin(): Promise<{ isAppAdmin: boolean }> {
  return apiFetch("/api/admin/whoami");
}

export function getHealth(): Promise<Health> {
  return apiFetch("/api/admin/health");
}

export function getEvents(query: EventQuery = {}): Promise<EventPage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "" && value !== null) {
      search.set(key, String(value));
    }
  }
  const q = search.toString();
  return apiFetch(`/api/admin/events${q ? `?${q}` : ""}`);
}

export function getSecurity(hours = 24): Promise<Security> {
  return apiFetch(`/api/admin/security?hours=${hours}`);
}
