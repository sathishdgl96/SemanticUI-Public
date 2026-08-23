import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  listDashboards,
  removeTile,
  setHomeDashboard,
} from "../api/dashboards";
import { getHome, type HomePayload } from "../api/home";
import { atLeast } from "../api/workspaces";
import TileGrid from "../dashboards/TileGrid";
import {
  useTileArrangement,
  withLayouts,
} from "../dashboards/useTileArrangement";
import RecentItems from "./RecentItems";

/** Offered when no dashboard is chosen -- which covers never having
 *  chosen, the chosen one being deleted, and losing access to its
 *  workspace. All three mean the same thing here. */
function DashboardPicker({ firstRun }: { firstRun: boolean }) {
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
    // Somebody with nothing at all is not one click from a dashboard: they
    // need a model first, then an explore, then a report to pin from. The
    // dashboard advice below is right for month two and wrong for minute one.
    if (firstRun) {
      return (
        <p className="tile-hint">
          Nothing to show here yet.{" "}
          <Link to="/explore">Explore a model</Link> to see what your Snowflake
          account already defines — a dashboard is the last step, not the first.
        </p>
      );
    }
    return (
      <p className="tile-hint">
        No dashboards yet. <Link to="/reports?kind=dashboard">Create one</Link>, then pin
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

  // Same queue the dashboard page uses, and for the same reason: the grid
  // reports a layout change on drag stop, on mount, and again whenever its
  // `layout` prop moves. Home nests its dashboard inside its own payload,
  // so it writes the saved layout back there itself.
  const arrangement = useTileArrangement({
    dashboardId: dashboard?.id ?? "",
    dashboard: dashboard ?? undefined,
    applySaved: (layouts) =>
      queryClient.setQueryData(["home"], (old: HomePayload | undefined) =>
        old?.dashboard
          ? { ...old, dashboard: withLayouts(old.dashboard, layouts) }
          : old,
      ),
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
        {/* Into the FILTERED list, not the whole of it: an entry called
            Dashboards that lands on everything is a link that did not do
            what it said. */}
        <span className="home-head-actions">
          <Link className="button secondary" to="/reports?kind=dashboard">
            Dashboards
          </Link>
          <Link className="button secondary" to="/reports?kind=report">
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
          <>
          {arrangement.failed && (
            <p role="alert" className="tile-hint">
              Could not save the new arrangement. Still trying.
            </p>
          )}
          <TileGrid
            tiles={dashboard.tiles}
            canEdit={canEdit}
            onRemove={(tileId) => unpin.mutate(tileId)}
            onRearrange={arrangement.onRearrange}
          />
          </>
        ) : (
          <DashboardPicker firstRun={home.data?.welcome?.path === "explore"} />
        )}
      </section>
    </main>
  );
}
