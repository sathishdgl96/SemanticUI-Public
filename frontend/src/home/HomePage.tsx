import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  listDashboards,
  removeTile,
  setHomeDashboard,
  updateDashboard,
  type DashboardDetail,
} from "../api/dashboards";
import { getHome } from "../api/home";
import { atLeast } from "../api/workspaces";
import TileGrid from "../dashboards/TileGrid";
import RecentItems from "./RecentItems";

/** Rebuild the stored document from what the server resolved, so a moved
 *  tile can be saved back. */
function definitionOf(
  dashboard: DashboardDetail,
  layouts?: { id: string; x: number; y: number; w: number; h: number }[],
) {
  const moved = new Map((layouts ?? []).map((entry) => [entry.id, entry]));
  return {
    schemaVersion: 1,
    name: dashboard.name,
    tiles: dashboard.tiles.map((tile) => {
      const next = moved.get(tile.id);
      return {
        id: tile.id,
        reportId: tile.reportId,
        pageId: tile.pageId,
        visualId: tile.visualId,
        title: tile.title,
        layout: next ? { x: next.x, y: next.y, w: next.w, h: next.h } : tile.layout,
      };
    }),
  };
}

/** Offered when no dashboard is chosen -- which covers never having
 *  chosen, the chosen one being deleted, and losing access to its
 *  workspace. All three mean the same thing here. */
function DashboardPicker() {
  const queryClient = useQueryClient();
  const dashboards = useQuery({
    queryKey: ["dashboards", "all"],
    queryFn: () => listDashboards(),
  });
  const choose = useMutation({
    mutationFn: (id: string) => setHomeDashboard(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["home"] }),
  });

  const listed = dashboards.data?.dashboards ?? [];

  if (dashboards.isLoading) return <p className="tile-hint">Loading…</p>;

  if (listed.length === 0) {
    return (
      <p className="tile-hint">
        No dashboards yet. <Link to="/dashboards">Create one</Link>, then pin
        visuals to it by right-clicking them on any report in its workspace.
      </p>
    );
  }

  return (
    <div className="home-picker">
      <p className="tile-hint">Choose a dashboard to open here.</p>
      <ul className="home-picker-list">
        {listed.map((dashboard) => (
          <li key={dashboard.id}>
            <button
              type="button"
              className="secondary"
              onClick={() => choose.mutate(dashboard.id)}
              disabled={choose.isPending}
            >
              {dashboard.name}
              <span className="home-picker-meta">{dashboard.workspaceName}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Home: what you were last working on, and the dashboard you chose.
 *
 * Both halves arrive in one request. The page has nothing to show without
 * each of them, and two round trips would only stagger the arrival.
 */
export default function HomePage() {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: getHome });
  const dashboard = home.data?.dashboard ?? null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["home"] });

  const unpin = useMutation({
    mutationFn: (tileId: string) => removeTile(dashboard?.id as string, tileId),
    onSuccess: invalidate,
  });

  const rearrange = useMutation({
    mutationFn: (layouts: { id: string; x: number; y: number; w: number; h: number }[]) =>
      updateDashboard(dashboard?.id as string, definitionOf(dashboard as DashboardDetail, layouts)),
    // Not invalidated on purpose: the grid already shows the new
    // arrangement, and refetching would drop every tile's query and flash
    // the whole page on a drag that changed nothing but position.
  });

  const clearChoice = useMutation({
    mutationFn: () => setHomeDashboard(null),
    onSuccess: invalidate,
  });

  const recent = home.data?.recent ?? [];
  const canEdit = dashboard ? atLeast(dashboard.myRole, "editor") : false;

  return (
    <main className="home">
      <header className="home-head">
        <h1 className="page-title">Home</h1>
        <span className="home-head-actions">
          <Link className="button secondary" to="/dashboards">
            Dashboards
          </Link>
          <Link className="button secondary" to="/reports">
            Reports
          </Link>
        </span>
      </header>

      {home.isError && (
        <p role="alert">
          {home.error instanceof ApiError
            ? home.error.message
            : "Could not load your home page."}
        </p>
      )}

      <section className="home-section" aria-labelledby="home-recent">
        <h2 className="home-section-title" id="home-recent">
          Recent
        </h2>
        {home.isLoading ? (
          <p className="tile-hint">Loading…</p>
        ) : (
          <RecentItems items={recent} />
        )}
      </section>

      <section className="home-section" aria-labelledby="home-dashboard">
        <h2 className="home-section-title" id="home-dashboard">
          {dashboard ? (
            <>
              <Link to={`/dashboards/${dashboard.id}`}>{dashboard.name}</Link>
              <button type="button" className="link" onClick={() => clearChoice.mutate()}>
                Change
              </button>
            </>
          ) : (
            "Dashboard"
          )}
        </h2>
        {home.isLoading ? null : dashboard ? (
          <TileGrid
            tiles={dashboard.tiles}
            canEdit={canEdit}
            onRemove={(tileId) => unpin.mutate(tileId)}
            onRearrange={(layouts) => rearrange.mutate(layouts)}
          />
        ) : (
          <DashboardPicker />
        )}
      </section>
    </main>
  );
}
