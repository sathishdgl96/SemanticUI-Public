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
import Announcement from "./Announcement";
import TileGrid from "./TileGrid";

/** The stored document, rebuilt from what the server resolved. Tiles are
 *  references; `detail` returns them resolved, so saving means putting the
 *  reference half back together. */
function definitionOf(
  dashboard: DashboardDetail,
  layouts?: { id: string; x: number; y: number; w: number; h: number }[],
) {
  const moved = new Map((layouts ?? []).map((entry) => [entry.id, entry]));
  return {
    schemaVersion: 1,
    name: dashboard.name,
    announcement: dashboard.announcement,
    tiles: dashboard.tiles.map((tile) => {
      const next = moved.get(tile.id);
      return {
        id: tile.id,
        reportId: tile.reportId,
        pageId: tile.pageId,
        visualId: tile.visualId,
        title: tile.title,
        layout: next
          ? { x: next.x, y: next.y, w: next.w, h: next.h }
          : tile.layout,
      };
    }),
  };
}

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

  const rearrange = useMutation({
    mutationFn: (layouts: { id: string; x: number; y: number; w: number; h: number }[]) =>
      updateDashboard(dashboardId, definitionOf(dashboard.data as DashboardDetail, layouts)),
    // Deliberately NOT invalidating: the grid already shows the new
    // arrangement, and refetching would drop every tile's query and make
    // the whole page flash on a drag that changed nothing but position.
  });

  const announce = useMutation({
    mutationFn: (announcement: string | null) =>
      updateDashboard(dashboardId, {
        ...definitionOf(dashboard.data as DashboardDetail),
        announcement,
      }),
    onSuccess: invalidate,
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

      {rearrange.isError && (
        <p role="alert">Could not save the new arrangement.</p>
      )}

      <Announcement
        text={dashboard.data.announcement}
        canEdit={canEdit}
        saving={announce.isPending}
        onChange={(next) => announce.mutate(next)}
      />

      <TileGrid
        tiles={dashboard.data.tiles}
        canEdit={canEdit}
        onRemove={(tileId) => unpin.mutate(tileId)}
        onRearrange={(layouts) => rearrange.mutate(layouts)}
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
