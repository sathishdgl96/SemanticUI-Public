import { apiFetch } from "./client";

export type AnnouncementLevel = "info" | "warning" | "critical";

export interface Announcement {
  id: string;
  message: string;
  level: AnnouncementLevel;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
  updatedAt: string | null;
}

/** What is showing right now. Everybody sees this. */
export function getLiveAnnouncements(): Promise<{ announcements: Announcement[] }> {
  return apiFetch("/api/announcements");
}

/** Every notice, including the ones switched off and the ones not due
 *  yet -- which only the person managing them has any use for. */
export function listAnnouncements(): Promise<{ announcements: Announcement[] }> {
  return apiFetch("/api/admin/announcements");
}

export function createAnnouncement(body: {
  message: string;
  level: AnnouncementLevel;
  endsAt?: string | null;
}): Promise<Announcement> {
  return apiFetch("/api/admin/announcements", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAnnouncement(
  id: string,
  body: {
    message?: string;
    level?: AnnouncementLevel;
    active?: boolean;
    endsAt?: string | null;
    clearEnd?: boolean;
  },
): Promise<Announcement> {
  return apiFetch(`/api/admin/announcements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteAnnouncement(id: string): Promise<void> {
  return apiFetch(`/api/admin/announcements/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
