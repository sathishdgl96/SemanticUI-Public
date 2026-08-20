import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getEvents, type EventQuery } from "../api/admin";
import { ApiError } from "../api/client";
import { exactTime, relativeTime } from "../ui/relativeTime";

/** How far back the log looks. "Everything" is deliberately offered: a
 *  question about last month is exactly what a trail is for. */
const WINDOWS: { label: string; hours?: number }[] = [
  { label: "Last hour", hours: 1 },
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 7 days", hours: 24 * 7 },
  { label: "Everything" },
];

/** An outcome that is not "it worked" is the thing a reader is looking
 *  for, so it is coloured rather than left as another word in a row. */
function outcomeClass(outcome: string): string {
  if (outcome === "ok") return "role-pill role-editor";
  if (outcome === "denied") return "role-pill role-denied";
  return "role-pill role-error";
}

/**
 * The audit trail, read.
 *
 * Rendered verbatim, which is safe because of the trail's own contract:
 * `detail` holds shapes -- counts, flags, durations -- never data values,
 * resource names or tokens. So a page that shows every field of every
 * event still cannot leak the contents of anybody's report.
 */
export default function ActivityPage() {
  const [filters, setFilters] = useState<EventQuery>({ hours: 24 });
  // Keyset paging: the trail grows while it is being read, and an offset
  // would skip or repeat rows as it did.
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const before = pages[pages.length - 1];

  const events = useQuery({
    queryKey: ["admin", "events", filters, before],
    queryFn: () => getEvents({ ...filters, before }),
    placeholderData: (previous) => previous,
  });

  const narrow = (next: Partial<EventQuery>) => {
    setFilters((current) => ({ ...current, ...next }));
    setPages([undefined]);
  };

  const rows = events.data?.events ?? [];

  return (
    <div className="admin-page">
      <div className="library-bar">
        <label className="library-sort">
          <span className="sr-only">Window</span>
          <select
            value={String(filters.hours ?? "")}
            onChange={(e) =>
              narrow({ hours: e.target.value ? Number(e.target.value) : undefined })
            }
          >
            {WINDOWS.map((w) => (
              <option key={w.label} value={w.hours ?? ""}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="library-sort">
          <span className="sr-only">Action</span>
          <select
            value={filters.action ?? ""}
            onChange={(e) => narrow({ action: e.target.value || undefined })}
          >
            <option value="">All actions</option>
            {/* What the trail actually holds, rather than a list written
                months ago that has drifted from the code. */}
            {(events.data?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>
        <label className="library-sort">
          <span className="sr-only">Outcome</span>
          <select
            value={filters.outcome ?? ""}
            onChange={(e) => narrow({ outcome: e.target.value || undefined })}
          >
            <option value="">Any outcome</option>
            <option value="ok">Succeeded</option>
            <option value="denied">Denied</option>
            <option value="error">Errored</option>
          </select>
        </label>
        <label className="admin-user-filter">
          <span className="sr-only">User</span>
          <input
            placeholder="Snowflake user"
            defaultValue={filters.user ?? ""}
            onBlur={(e) => narrow({ user: e.target.value.trim() || undefined })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                narrow({ user: (e.target as HTMLInputElement).value.trim() || undefined });
              }
            }}
          />
        </label>
      </div>

      {events.isError && (
        <p role="alert">
          {events.error instanceof ApiError
            ? events.error.message
            : "Could not read the activity log."}
        </p>
      )}

      <div className="library-results">
        {events.isLoading && <p>Reading the log…</p>}
        {!events.isLoading && rows.length === 0 && (
          <p className="empty">Nothing recorded in this window.</p>
        )}

        {rows.length > 0 && (
          <table className="content-table log-table">
            <colgroup>
              <col className="col-when" />
              <col className="col-action" />
              <col className="col-outcome" />
              <col className="col-actor" />
              <col className="col-resource" />
              <col className="col-detail" />
            </colgroup>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>User</th>
                <th>Resource</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <tr key={event.id}>
                  <td title={exactTime(event.ts)}>{relativeTime(event.ts)}</td>
                  <td className="log-action">{event.action}</td>
                  <td>
                    <span className={outcomeClass(event.outcome)}>{event.outcome}</span>
                  </td>
                  <td>{event.user || "—"}</td>
                  <td className="log-resource">
                    {event.resourceType
                      ? `${event.resourceType}${event.resourceId ? ` ${event.resourceId.slice(0, 8)}` : ""}`
                      : "—"}
                  </td>
                  <td className="log-detail">
                    {/* The request id is what joins this row to the log
                        stream, and through the query id logged there to
                        Snowflake's own QUERY_HISTORY. */}
                    {event.requestId && (
                      <span className="log-request" title="Request id">
                        {event.requestId.slice(0, 8)}
                      </span>
                    )}
                    {event.detail ? JSON.stringify(event.detail) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="log-paging">
        <button
          type="button"
          className="secondary"
          disabled={pages.length === 1}
          onClick={() => setPages((current) => current.slice(0, -1))}
        >
          Newer
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!events.data?.nextBefore}
          onClick={() =>
            setPages((current) => [...current, events.data?.nextBefore ?? undefined])
          }
        >
          Older
        </button>
      </div>
    </div>
  );
}
