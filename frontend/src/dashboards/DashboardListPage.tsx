import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { createDashboard, listDashboards } from "../api/dashboards";
import { atLeast } from "../api/workspaces";
import Icon from "../ui/Icon";
import { exactTime, relativeTime } from "../ui/relativeTime";
import WorkspaceSwitcher from "../workspaces/WorkspaceSwitcher";
import { useWorkspaces } from "../workspaces/useWorkspaces";

/** The dashboards of one workspace.
 *
 *  A sibling of the report list, and scoped the same way: the selection
 *  lives in the URL so the rail's flyout and this page share one source of
 *  truth and a workspace view is linkable. */
export default function DashboardListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const [createError, setCreateError] = useState<string | null>(null);

  const workspaces = useWorkspaces();
  const rows = workspaces.data?.workspaces ?? [];
  const selectedId = workspaceId ?? rows.find((w) => w.kind === "personal")?.id ?? "";
  const selected = rows.find((w) => w.id === selectedId);
  const canCreateHere = selected ? atLeast(selected.myRole, "editor") : false;

  const dashboards = useQuery({
    queryKey: ["dashboards", selectedId],
    queryFn: () => listDashboards(selectedId || undefined),
    enabled: Boolean(selectedId),
  });

  const create = useMutation({
    mutationFn: () => createDashboard("Untitled dashboard", selectedId || undefined),
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      navigate(`/dashboards/${dashboard.id}`);
    },
    onError: (error) =>
      setCreateError(
        error instanceof ApiError ? error.message : "Could not create a dashboard.",
      ),
  });

  const listed = dashboards.data?.dashboards ?? [];

  return (
    <main className="reports">
      <header className="reports-head">
        <div className="ws-title">
          <h1 className="page-title">Dashboards</h1>
          {selected && <p className="ws-subtitle">{selected.name}</p>}
        </div>
        <WorkspaceSwitcher
          value={selectedId}
          onChange={(id) => setSearchParams({ workspace: id })}
          onCreated={(id) => setSearchParams({ workspace: id })}
          onManageMembers={() => navigate(`/reports?workspace=${selectedId}`)}
        />
        <div className="reports-actions">
          <button
            onClick={() => {
              setCreateError(null);
              create.mutate();
            }}
            disabled={create.isPending || !canCreateHere}
          >
            {create.isPending ? "Creating…" : "New dashboard"}
          </button>
        </div>
      </header>

      {selected && !canCreateHere && (
        <p className="tile-hint">
          Your access to {selected.name} is read-only. Dashboards can be created in
          a workspace you can edit.
        </p>
      )}
      {createError && <p role="alert">{createError}</p>}

      {dashboards.isLoading && <p>Loading dashboards…</p>}
      {dashboards.isError && (
        <p role="alert">
          {dashboards.error instanceof ApiError
            ? dashboards.error.message
            : "Could not load your dashboards."}
        </p>
      )}

      {dashboards.data && listed.length === 0 && (
        <p className="empty">
          No dashboards here yet. A dashboard gathers visuals from any report in
          this workspace onto one canvas.
        </p>
      )}

      {listed.length > 0 && (
        <table className="content-table">
          <thead>
            <tr>
              <th aria-hidden="true"></th>
              <th>Name</th>
              <th>Tiles</th>
              <th>Your role</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((dashboard) => (
              <tr key={dashboard.id}>
                <td className="type-glyph" aria-hidden="true">
                  <Icon name="dashboard" size={16} />
                </td>
                <td>
                  <Link className="report-name" to={`/dashboards/${dashboard.id}`}>
                    {dashboard.name}
                  </Link>
                </td>
                <td>{dashboard.tileCount}</td>
                <td>{dashboard.myRole}</td>
                <td
                  className="report-updated"
                  title={dashboard.updatedAt ? exactTime(dashboard.updatedAt) : ""}
                >
                  {dashboard.updatedAt ? relativeTime(dashboard.updatedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
