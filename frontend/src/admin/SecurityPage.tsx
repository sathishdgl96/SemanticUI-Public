import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getSecurity } from "../api/admin";
import { ApiError } from "../api/client";
import { exactTime, relativeTime } from "../ui/relativeTime";

const WINDOWS = [
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 7 days", hours: 24 * 7 },
  { label: "Last 14 days", hours: 24 * 14 },
];

/** Events per hour, drawn without a chart library.
 *
 *  A sparkline is a shape, not a chart: no axes, no legend, nothing to
 *  read off it but "was it busy, and when". Loading ECharts to draw
 *  fourteen rectangles would cost more than the answer is worth. */
function Sparkline({ points }: { points: { hour: string; count: number }[] }) {
  const peak = Math.max(1, ...points.map((p) => p.count));
  return (
    <div
      className="sparkline"
      role="img"
      aria-label={`${points.reduce((sum, p) => sum + p.count, 0)} events over ${points.length} hours`}
    >
      {points.map((point) => (
        <span
          key={point.hour}
          className="sparkline-bar"
          style={{ height: `${Math.round((point.count / peak) * 100)}%` }}
          title={`${exactTime(point.hour)} — ${point.count} event${point.count === 1 ? "" : "s"}`}
        />
      ))}
    </div>
  );
}

/**
 * What an operator should look at, derived from the audit trail.
 *
 * Alerts rather than raw counts: "seventeen sign-in failures" is a
 * number, "seventeen sign-in failures from four sessions" is the thing
 * worth acting on. Each one says what it counted and over what window,
 * because an alert you cannot check is an alert you learn to ignore.
 */
export default function SecurityPage() {
  const [hours, setHours] = useState(24);
  const security = useQuery({
    queryKey: ["admin", "security", hours],
    queryFn: () => getSecurity(hours),
    refetchInterval: 60_000,
  });

  if (security.isError) {
    return (
      <p role="alert">
        {security.error instanceof ApiError
          ? security.error.message
          : "Could not read the security board."}
      </p>
    );
  }
  if (security.isLoading || !security.data) return <p>Checking…</p>;

  const { alerts, recentDenials, activity } = security.data;

  return (
    <div className="admin-page">
      <div className="library-bar">
        <label className="library-sort">
          <span className="sr-only">Window</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="alert-list">
        {alerts.map((alert) => (
          <li key={alert.id} className={`alert alert-${alert.severity}`}>
            <span className="alert-severity">{alert.severity}</span>
            <span className="alert-body">
              <strong>{alert.title}</strong>
              <span className="alert-detail">{alert.detail}</span>
            </span>
            {alert.count > 0 && <span className="alert-count">{alert.count}</span>}
          </li>
        ))}
      </ul>

      <h3 className="admin-section-title">Activity</h3>
      <Sparkline points={activity} />

      <h3 className="admin-section-title">Recent refusals</h3>
      {recentDenials.length === 0 ? (
        <p className="empty">Nobody was refused anything in this window.</p>
      ) : (
        <table className="content-table log-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>User</th>
              <th>Resource</th>
            </tr>
          </thead>
          <tbody>
            {recentDenials.map((denial) => (
              <tr key={denial.id}>
                <td title={exactTime(denial.ts)}>{relativeTime(denial.ts)}</td>
                <td className="log-action">{denial.action}</td>
                <td>{denial.user || "—"}</td>
                <td>{denial.resourceType ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
