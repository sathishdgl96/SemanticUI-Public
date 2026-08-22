import { useEffect, useRef, useState } from "react";
import type { DashboardDetail } from "../api/dashboards";
import { updateDashboard } from "../api/dashboards";
import { createSaveQueue, type TileLayout } from "./saveQueue";

/** The reference half of a dashboard, which is what a save puts back:
 *  `detail` returns tiles resolved, and the server wants them named. */
export function definitionOf(
  dashboard: DashboardDetail,
  layouts: TileLayout[] = [],
) {
  const moved = new Map(layouts.map((entry) => [entry.id, entry]));
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
        layout: next
          ? { x: next.x, y: next.y, w: next.w, h: next.h }
          : tile.layout,
      };
    }),
  };
}

/** The same dashboard with the given positions applied. Used to bring the
 *  cache level with what was just saved, without refetching it. */
export function withLayouts(
  dashboard: DashboardDetail,
  layouts: TileLayout[],
): DashboardDetail {
  const moved = new Map(layouts.map((entry) => [entry.id, entry]));
  return {
    ...dashboard,
    tiles: dashboard.tiles.map((tile) => {
      const next = moved.get(tile.id);
      return next
        ? { ...tile, layout: { x: next.x, y: next.y, w: next.w, h: next.h } }
        : tile;
    }),
  };
}

/**
 * Saving a dashboard's arrangement, reliably, in the background.
 *
 * Two things were wrong, and only both together explain "it saves
 * sometimes".
 *
 * The grid holds no layout state of its own -- its `layout` prop is derived
 * from the cached dashboard. Rearranging deliberately did not update that
 * cache, to avoid refetching every tile and flashing the page. So once a
 * drag finished and any re-render followed (the mutation's own pending flag
 * was enough), the STALE layout was handed back to the grid, which reported
 * it as a change and issued a second write undoing the first. Which of the
 * two the server committed last was a race the client could not see.
 *
 * The cache is therefore updated here -- locally, from the layout just
 * saved, never by refetching. The original reason for not invalidating
 * stands; the mistake was concluding that meant leaving the cache wrong.
 *
 * And writes are queued rather than fired per event: coalesced, one at a
 * time, newest wins, retried on failure. See `saveQueue`.
 */
export function useTileArrangement({
  dashboardId,
  dashboard,
  applySaved,
}: {
  dashboardId: string;
  dashboard: DashboardDetail | undefined;
  /** Bring the caller's cache level with what was saved. Home keeps its
   *  dashboard nested inside its own payload, so only the caller knows the
   *  shape to write back into. */
  applySaved: (layouts: TileLayout[]) => void;
}) {
  const [failed, setFailed] = useState(false);
  // Read through refs so a drag made ten minutes later still saves against
  // the dashboard as it is then, not as it was when the queue was built.
  const latest = useRef(dashboard);
  latest.current = dashboard;
  const apply = useRef(applySaved);
  apply.current = applySaved;

  const queueRef = useRef<ReturnType<typeof createSaveQueue> | null>(null);

  if (!queueRef.current && dashboard) {
    // What the server already holds. Without it the grid's report of its own
    // layout on mount would be written straight back as an edit.
    const baseline = dashboard.tiles.map((tile) => ({
      id: tile.id,
      ...tile.layout,
    }));
    queueRef.current = createSaveQueue(
      async (layouts) => {
        const current = latest.current;
        if (!current) return;
        try {
          await updateDashboard(dashboardId, definitionOf(current, layouts));
        } catch (error) {
          // Surfaced, and rethrown so the queue retries rather than
          // dropping an arrangement on one bad connection.
          setFailed(true);
          throw error;
        }
        setFailed(false);
        apply.current(layouts);
      },
      400,
      baseline,
    );
  }

  useEffect(() => {
    const queue = queueRef.current;
    return () => queue?.dispose();
  }, []);

  return {
    failed,
    onRearrange: (layouts: TileLayout[]) => queueRef.current?.push(layouts),
  };
}
