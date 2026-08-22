import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import { ApiError } from "../api/client";
import {
  deleteDashboard,
  getDashboard,
  removeTile,
  setHomeDashboard,
  updateDashboard,
  type DashboardDetail,
} from "../api/dashboards";
import { atLeast } from "../api/workspaces";
import Icon from "../ui/Icon";
import TileGrid from "./TileGrid";
import {
  definitionOf,
  useTileArrangement,
  withLayouts,
} from "./useTileArrangement";

/** One dashboard: visuals gathered from the reports of its workspace. */
export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const dashboardId = id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dashboard = useQuery({
    queryKey: ["dashboard", dashboardId],
    queryFn: () => getDashboard(dashboardId),
    enabled: Boolean(dashboardId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
    queryClient.invalidateQueries({ queryKey: ["dashboards"] });
  };

  const unpin = useMutation({
    mutationFn: (tileId: string) => removeTile(dashboardId, tileId),
    onSuccess: invalidate,
  });

  // Not a mutation: react-grid-layout reports a layout change on drag stop,
  // on mount, and again whenever its `layout` prop moves, so firing a
  // request per event put several writes of one document in the air at
  // once. See useTileArrangement.
  const arrangement = useTileArrangement({
    dashboardId,
    dashboard: dashboard.data,
    applySaved: (layouts) =>
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (old: DashboardDetail | undefined) =>
          old ? withLayouts(old, layouts) : old,
      ),
  });

  const rename = useMutation({
    mutationFn: (name: string) =>
      updateDashboard(dashboardId, {
        ...definitionOf(dashboard.data as DashboardDetail),
        name,
      }),
    onSuccess: invalidate,
  });

  const makeHome = useMutation({
    mutationFn: () => setHomeDashboard(dashboardId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["home"] }),
  });

  const remove = useMutation({
    mutationFn: () => deleteDashboard(dashboardId),
    onSuccess: () => {
      invalidate();
      navigate("/dashboards");
    },
  });

  if (dashboard.isError) {
    return (
      <p role="alert">
        {dashboard.error instanceof ApiError
          ? dashboard.error.message
          : "Could not load this dashboard."}
      </p>
    );
  }
  if (dashboard.isLoading || !dashboard.data) return <p>Loading dashboard…</p>;

  const canEdit = atLeast(dashboard.data.myRole, "editor");

  return (
    <main className="dashboard">
      <header className="builder-head command-bar">
        <input
          className="report-title"
          aria-label="Dashboard name"
          defaultValue={dashboard.data.name}
          readOnly={!canEdit}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (canEdit && next && next !== dashboard.data?.name) rename.mutate(next);
          }}
        />
        <div className="builder-actions">
          <button
            type="button"
            className="cmd"
            onClick={() => makeHome.mutate()}
            disabled={makeHome.isPending}
          >
            <Icon name="home" />
            {makeHome.isSuccess ? "On your home" : "Set as home"}
          </button>
          <span className="cmd-sep" aria-hidden="true" />
          <button
            type="button"
            className="cmd"
            disabled={!canEdit}
            title={canEdit ? undefined : "You can read this dashboard but not change it."}
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" />
            Delete
          </button>
        </div>
      </header>

      <p className="dashboard-meta">
        {dashboard.data.workspaceName} · {dashboard.data.tileCount} tile
        {dashboard.data.tileCount === 1 ? "" : "s"}
      </p>

      {arrangement.failed && (
        <p role="alert">
          Could not save the new arrangement. Still trying.
        </p>
      )}

      <TileGrid
        tiles={dashboard.data.tiles}
        canEdit={canEdit}
        onRemove={(tileId) => unpin.mutate(tileId)}
        onRearrange={arrangement.onRearrange}
      />

      {confirmDelete && (
        <div className="confirm" role="dialog" aria-label="Confirm delete">
          <p>
            Delete this dashboard? The reports it draws from are not affected.
          </p>
          <button onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? "Deleting…" : "Delete"}
          </button>
          <button className="secondary" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}
    </main>
  );
}
