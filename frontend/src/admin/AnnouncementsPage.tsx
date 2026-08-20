import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  type Announcement,
  type AnnouncementLevel,
} from "../api/announcements";
import { ApiError } from "../api/client";
import Icon from "../ui/Icon";
import { exactTime, relativeTime } from "../ui/relativeTime";

const LEVELS: { value: AnnouncementLevel; label: string; meaning: string }[] = [
  { value: "info", label: "Information", meaning: "Worth knowing" },
  { value: "warning", label: "Warning", meaning: "Plan around it" },
  { value: "critical", label: "Critical", meaning: "Interrupts the reader" },
];

/** Live, waiting, finished or switched off -- the four states a notice can
 *  be in, said in words rather than left to be worked out from two dates
 *  and a flag. */
function statusOf(row: Announcement): { label: string; tone: string } {
  if (!row.active) return { label: "Off", tone: "muted" };
  const now = Date.now();
  if (row.startsAt && Date.parse(row.startsAt) > now) {
    return { label: "Scheduled", tone: "info" };
  }
  if (row.endsAt && Date.parse(row.endsAt) <= now) {
    return { label: "Finished", tone: "muted" };
  }
  return { label: "Showing", tone: "live" };
}

/**
 * Writing what everybody sees.
 *
 * In the admin area because that is where the gate is: a broadcast to
 * every user of the deployment is not a permission any row in the
 * database should be able to grant, so it comes from the same list in the
 * environment as the rest of this section.
 */
export default function AnnouncementsPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");
  const [endsAt, setEndsAt] = useState("");

  const rows = useQuery({
    queryKey: ["admin", "announcements"],
    queryFn: listAnnouncements,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "announcements"] });
    // What everybody is reading changed too.
    queryClient.invalidateQueries({ queryKey: ["announcements", "live"] });
  };

  const write = useMutation({
    mutationFn: () =>
      createAnnouncement({
        message: message.trim(),
        level,
        // A local datetime from the picker; the server stores UTC.
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      }),
    onSuccess: () => {
      setMessage("");
      setEndsAt("");
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: (row: Announcement) =>
      updateAnnouncement(row.id, { active: !row.active }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAnnouncement(id),
    onSuccess: refresh,
  });

  const listed = rows.data?.announcements ?? [];
  const failure = write.error ?? toggle.error ?? remove.error;

  return (
    <div className="admin-page">
      <form
        className="member-add"
        aria-label="Write an announcement"
        onSubmit={(event) => {
          event.preventDefault();
          if (message.trim()) write.mutate();
        }}
      >
        <h4 className="member-add-title">Write an announcement</h4>
        <label className="sr-only" htmlFor="announcement-message">
          Message
        </label>
        <textarea
          id="announcement-message"
          value={message}
          maxLength={500}
          rows={2}
          placeholder="What should everybody know?"
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="member-add-row">
          <span className="field">
            <label htmlFor="announcement-level">Level</label>
            <select
              id="announcement-level"
              value={level}
              onChange={(event) => setLevel(event.target.value as AnnouncementLevel)}
            >
              {LEVELS.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </span>
          <span className="field">
            {/* Optional on purpose: open-ended is right for a standing
                notice and wrong for a maintenance window, so both are
                offered rather than one being assumed. */}
            <label htmlFor="announcement-ends">Stops showing (optional)</label>
            <input
              id="announcement-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </span>
          <button type="submit" disabled={!message.trim() || write.isPending}>
            {write.isPending ? "Posting…" : "Post"}
          </button>
        </div>
        <p className="tile-hint">
          {LEVELS.find((choice) => choice.value === level)?.meaning}. Everybody
          signed in sees it, wherever they are in the app.
        </p>
      </form>

      {failure && (
        <p role="alert">
          {failure instanceof ApiError ? failure.message : "That did not work."}
        </p>
      )}

      {rows.isLoading && <p>Loading…</p>}
      {!rows.isLoading && listed.length === 0 && (
        <p className="empty">Nothing has been announced.</p>
      )}

      {listed.length > 0 && (
        <table className="content-table log-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Message</th>
              <th>Level</th>
              <th>Stops</th>
              <th>By</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listed.map((row) => {
              const status = statusOf(row);
              return (
                <tr key={row.id}>
                  <td>
                    <span className={`role-pill status-${status.tone}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="announcement-message" title={row.message}>
                    {row.message}
                  </td>
                  <td>{row.level}</td>
                  <td title={row.endsAt ? exactTime(row.endsAt) : ""}>
                    {row.endsAt ? relativeTime(row.endsAt) : "—"}
                  </td>
                  <td>{row.createdBy || "—"}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="link"
                      onClick={() => toggle.mutate(row)}
                      disabled={toggle.isPending}
                    >
                      {row.active ? "Take down" : "Put up"}
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Delete announcement: ${row.message.slice(0, 40)}`}
                      onClick={() => remove.mutate(row.id)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
