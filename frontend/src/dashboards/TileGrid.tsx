import GridLayout, { type Layout } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { useNavigate } from "react-router-dom";
import type { DashboardTile } from "../api/dashboards";
import VisualTile from "../reports/VisualTile";
import ContextMenu, { useContextMenu, type MenuItem } from "../ui/ContextMenu";

export const COLUMNS = 12;
export const ROW_HEIGHT = 40;
/** Below this the grid stops being a layout and becomes a column of
 *  slivers, exactly as on the report canvas. */
const STACK_BELOW = 640;
const MIN_STACKED_ROWS = 6;

/** Width is measured rather than assumed, so the grid tracks its pane. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function layoutFor(tiles: DashboardTile[], stacked: boolean): Layout[] {
  if (!stacked) {
    return tiles.map((tile) => ({
      i: tile.id,
      x: tile.layout.x,
      y: tile.layout.y,
      w: tile.layout.w,
      h: tile.layout.h,
      minW: 2,
      minH: 3,
    }));
  }
  return [...tiles]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .reduce<Layout[]>((rows, tile) => {
      const h = Math.max(tile.layout.h, MIN_STACKED_ROWS);
      const y = rows.reduce((sum, row) => sum + row.h, 0);
      // `static`, not merely undraggable: on a touch screen a drag IS the
      // scroll gesture, and letting the grid claim it traps the page.
      rows.push({ i: tile.id, x: 0, y, w: 1, h, static: true });
      return rows;
    }, []);
}

/**
 * The tiles of a dashboard, in the arrangement they were left in.
 *
 * Each live tile is a real `VisualTile` -- the same component the report
 * canvas draws -- fed the visual and the scopes the server resolved. So a
 * tile queries exactly what the report queries, on the caller's own
 * Snowflake connection, and cannot drift into showing a different number
 * from the report it came from.
 */
export default function TileGrid({
  tiles,
  canEdit,
  onRemove,
  onRearrange,
}: {
  tiles: DashboardTile[];
  /** A viewer reads a dashboard; they do not rearrange it for everyone. */
  canEdit: boolean;
  onRemove: (tileId: string) => void;
  onRearrange: (
    layouts: { id: string; x: number; y: number; w: number; h: number }[],
  ) => void;
}) {
  const { ref, width } = useMeasuredWidth();
  const navigate = useNavigate();
  const menu = useContextMenu();
  const [target, setTarget] = useState<DashboardTile | null>(null);

  if (tiles.length === 0) {
    return (
      <div className="tile-grid-empty" ref={ref}>
        <p className="tile-hint">
          Nothing pinned yet. Open a report in this workspace, right-click a
          visual and choose <strong>Pin to dashboard</strong>.
        </p>
      </div>
    );
  }

  const stacked = width < STACK_BELOW;

  const menuItems = (tile: DashboardTile): MenuItem[] => [
    {
      id: "open",
      label: "Open the report",
      icon: "open",
      onSelect: () => navigate(`/reports/${tile.reportId}`),
    },
    {
      id: "unpin",
      label: "Remove from dashboard",
      icon: "trash",
      danger: true,
      separatorBefore: true,
      disabledReason: canEdit ? undefined : "You can read this dashboard but not change it.",
      onSelect: () => onRemove(tile.id),
    },
  ];

  return (
    <div className={stacked ? "tile-grid stacked" : "tile-grid"} ref={ref}>
      <GridLayout
        className="layout"
        layout={layoutFor(tiles, stacked)}
        cols={stacked ? 1 : COLUMNS}
        rowHeight={ROW_HEIGHT}
        width={width}
        margin={[12, 12]}
        isDraggable={canEdit && !stacked}
        isResizable={canEdit && !stacked}
        draggableHandle=".tile-head"
        onLayoutChange={(next) => {
          // A stacked layout is a RENDERING of the real one, not an edit of
          // it. Saving it would flatten the dashboard for everyone the
          // first time somebody opened it on a phone.
          if (stacked || !canEdit) return;
          onRearrange(
            next.map((entry) => ({
              id: entry.i,
              x: entry.x,
              y: entry.y,
              w: entry.w,
              h: entry.h,
            })),
          );
        }}
      >
        {tiles.map((tile) => (
          <div
            key={tile.id}
            className="tile-cell"
            onContextMenu={(event) => {
              setTarget(tile);
              menu.open(event);
            }}
          >
            {tile.available ? (
              <VisualTile
                visual={tile.title ? { ...tile.visual, title: tile.title } : tile.visual}
                view={tile.view}
                selected={false}
                onSelect={() => {}}
                reportFilters={tile.reportFilters}
                pageFilters={tile.pageFilters}
                hierarchies={tile.hierarchies}
              />
            ) : (
              // Not an error state: the frame is still the dashboard's, it
              // is the thing inside that went away.
              <div className="tile tile-dead">
                <div className="tile-head">
                  <span className="tile-title">
                    {tile.title ?? tile.reportName ?? "Tile"}
                  </span>
                </div>
                <div className="tile-body">
                  <p className="tile-hint">{tile.reason}</p>
                  {canEdit && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onRemove(tile.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </GridLayout>

      {menu.at && target && (
        <ContextMenu at={menu.at} items={menuItems(target)} onClose={menu.close} />
      )}
    </div>
  );
}
