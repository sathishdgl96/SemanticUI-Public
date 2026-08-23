import { useQuery } from "@tanstack/react-query";
import { getLiveAnnouncements, type AnnouncementLevel } from "../api/announcements";

const BADGE: Record<AnnouncementLevel, string> = {
  info: "i",
  warning: "!",
  critical: "!",
};

/**
 * What whoever runs this deployment is telling everybody.
 *
 * Its own section rather than a caption on a dashboard: "Snowflake is
 * down for maintenance on Saturday" is not a fact about one set of
 * numbers, and nobody should have to open a particular dashboard to find
 * it.
 *
 * Not dismissible, for the same reason it is not per-dashboard: a notice
 * half the readers have turned off is a notice half the readers do not
 * have. It stops showing when whoever wrote it says so, or when the
 * window they set for it closes.
 */
export default function AnnouncementBanner() {
  const live = useQuery({
    queryKey: ["announcements", "live"],
    queryFn: getLiveAnnouncements,
    // Long enough not to be chatty, short enough that a notice put up
    // during the working day arrives without a reload.
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  const showing = live.data?.announcements ?? [];
  // Absent rather than an empty frame: a section that is usually blank
  // teaches people to ignore the place it sits in.
  if (showing.length === 0) return null;

  return (
    <section className="announcements" aria-label="Announcements">
      {showing.map((announcement) => (
        <aside
          key={announcement.id}
          className={`announcement level-${announcement.level}`}
          // A critical notice interrupts; the other two do not. Marking
          // every one an alert would make the loud one indistinguishable
          // from the routine one to anybody listening rather than looking.
          role={announcement.level === "critical" ? "alert" : "note"}
        >
          <span className="announcement-badge" aria-hidden="true">
            {BADGE[announcement.level]}
          </span>
          <p>{announcement.message}</p>
        </aside>
      ))}
    </section>
  );
}
