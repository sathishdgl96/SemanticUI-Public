import { NavLink, Route, Routes } from "react-router-dom";
import ActivityPage from "./ActivityPage";
import OperationsPage from "./OperationsPage";
import SecurityPage from "./SecurityPage";

const TABS = [
  { to: "/admin", label: "Operations", end: true },
  { to: "/admin/activity", label: "Activity log" },
  { to: "/admin/security", label: "Security" },
];

/**
 * The admin area: how the system is doing, what happened, what to worry
 * about.
 *
 * Three views of the same deployment rather than three places, so the
 * question "was that outage the database?" is one tab away from the
 * answer rather than a different page you have to remember exists.
 */
export default function AdminPage() {
  return (
    <main className="admin">
      <header className="reports-head">
        <div className="ws-title">
          <h1 className="page-title">Administration</h1>
          <p className="ws-subtitle">
            Visible to the administrators named in this deployment's configuration.
          </p>
        </div>
      </header>

      <nav className="kind-filter admin-tabs" aria-label="Admin sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => (isActive ? "kind-tab on" : "kind-tab")}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<OperationsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="security" element={<SecurityPage />} />
      </Routes>
    </main>
  );
}
