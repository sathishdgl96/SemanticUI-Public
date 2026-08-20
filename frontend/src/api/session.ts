import { apiFetch } from "./client";

export interface SessionContext {
  role: string | null;
  warehouse: string | null;
  roles: string[];
  warehouses: string[];
}

export interface SessionContextChoice {
  role?: string | null;
  warehouse?: string | null;
}

export function getSessionContext(): Promise<SessionContext> {
  return apiFetch<SessionContext>("/api/session/context");
}

/** Omitted fields are left as they are, so switching the warehouse cannot
 *  silently reset the role. */
export function setSessionContext(
  next: SessionContextChoice,
): Promise<{ role: string | null; warehouse: string | null }> {
  return apiFetch<{ role: string | null; warehouse: string | null }>(
    "/api/session/context",
    { method: "POST", body: JSON.stringify(next) },
  );
}
