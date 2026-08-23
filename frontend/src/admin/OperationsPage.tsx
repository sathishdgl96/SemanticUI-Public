import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { getHealth } from "../api/admin";

/** "3d 4h 12m" -- an operator reads uptime in units, not seconds. */
function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const COUNT_LABELS: Record<string, string> = {
  users: "Users",
  workspaces: "Workspaces",
  reports: "Reports",
  dashboards: "Dashboards",
  explores: "Explores",
};

/** How the system is doing: is each moving part answering, and how fast.
 *
 *  Polled rather than pushed. A health page nobody is looking at costs
 *  nothing, and one that is being looked at should not need reloading to
 *  tell you the database came back. */
export default function OperationsPage() {
  const health = useQuery({
    queryKey: ["admin", "health"],
    queryFn: getHealth,
    refetchInterval: 15_000,
  });

  if (health.isError) {
    return (
      <p role="alert">
        {health.error instanceof ApiError
          ? health.error.message
          : "Could not read the system's health."}
      </p>
    );
  }
  if (health.isLoading || !health.data) return <p>Checking…</p>;

  const { status, checks, counts, uptimeSeconds } = health.data;

  return (
    <div className="admin-page">
      <div className={`ops-banner ops-${status}`} role="status">
        <span className="ops-dot" aria-hidden="true" />
        <strong>{status === "ok" ? "All systems answering" : "Something is down"}</strong>
        <span className="ops-uptime">API up {uptime(uptimeSeconds)}</span>
      </div>

      <ul className="ops-checks">
        {checks.map((check) => (
          <li key={check.name} className={`ops-check ops-${check.status}`}>
            <span className="ops-dot" aria-hidden="true" />
            <span className="ops-check-name">{check.name}</span>
            <span className="ops-check-detail">{check.detail}</span>
            <span className="ops-check-latency">
              {check.latencyMs === null ? "" : `${check.latencyMs} ms`}
            </span>
            <span className={`role-pill role-${check.status === "ok" ? "editor" : ""}`}>
              {check.status === "ok" ? "OK" : "DOWN"}
            </span>
          </li>
        ))}
        {/* The browser is answering by definition -- this page is the
            proof -- so it is stated rather than measured, and saying
            nothing about it would leave the reader wondering. */}
        <li className="ops-check ops-ok">
          <span className="ops-dot" aria-hidden="true" />
          <span className="ops-check-name">Web app</span>
          <span className="ops-check-detail">this page</span>
          <span className="ops-check-latency" />
          <span className="role-pill role-editor">OK</span>
        </li>
      </ul>

      <h3 className="admin-section-title">What this install holds</h3>
      <ul className="ops-counts">
        {Object.entries(counts).map(([key, value]) => (
          <li key={key}>
            <span className="ops-count-value">{value}</span>
            <span className="ops-count-label">{COUNT_LABELS[key] ?? key}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
