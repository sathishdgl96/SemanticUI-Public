import GridLayout, { type Layout } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Link } from "react-router-dom";
import type { HomeWidget } from "../api/home";
import VisualTile from "../reports/VisualTile";

/** The grid the home page draws on. Narrower than a report canvas on
 *  purpose: a home widget is a glance, not a page. */
export const COLUMNS = 8;
export const ROW_HEIGHT = 44;
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

export function layoutFor(widgets: HomeWidget[], stacked: boolean): Layout[] {
  if (!stacked) {
    return widgets.map((widget) => ({
      i: widget.id,
      x: widget.layout.x,
      y: widget.layout.y,
      w: widget.layout.w,
      h: widget.layout.h,
      minW: 2,
      minH: 3,
    }));
  }
  return [...widgets]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .reduce<Layout[]>((rows, widget) => {
      const h = Math.max(widget.layout.h, MIN_STACKED_ROWS);
      const y = rows.reduce((sum, row) => sum + row.h, 0);
      // `static`, not merely undraggable: on a touch screen a drag IS the
      // scroll gesture, and letting the grid claim it traps the page.
      rows.push({ i: widget.id, x: 0, y, w: 1, h, static: true });
      return rows;
    }, []);
}

/** A widget whose report or visual is gone, or is no longer this user's to
 *  read. Deliberately one message for all three: telling them apart would
 *  tell a former member that a report they cannot read still exists. */
function DeadTile({ widget, onRemove }: { widget: HomeWidget; onRemove: () => void }) {
  if (widget.available) return null;
  return (
    <div className="tile widget-dead">
      <div className="tile-head">
        <span className="tile-title">{widget.title ?? widget.reportName ?? "Widget"}</span>
      </div>
      <div className="tile-body">
        <p className="tile-hint">{widget.reason}</p>
        <button type="button" className="secondary" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * The pinned visuals, in the arrangement they were left in.
 *
 * Each live widget is a real `VisualTile` -- the same component the report
 * canvas draws -- fed the visual and the scopes the server resolved. So a
 * widget queries exactly what the report queries, on the caller's own
 * Snowflake connection, and cannot drift into showing a different number
 * from the report it came from.
 */
export default function WidgetGrid({
  widgets,
  onRemove,
  onRearrange,
}: {
  widgets: HomeWidget[];
  onRemove: (widgetId: string) => void;
  onRearrange: (layouts: { id: string; x: number; y: number; w: number; h: number }[]) => void;
}) {
  const { ref, width } = useMeasuredWidth();

  if (widgets.length === 0) {
    return (
      <div className="widget-empty" ref={ref}>
        <p className="tile-hint">
          Nothing pinned yet. Open a report, and use a visual's <strong>Pin to
          home</strong> to put it here.
        </p>
      </div>
    );
  }

  const stacked = width < STACK_BELOW;

  return (
    <div className={stacked ? "widget-grid stacked" : "widget-grid"} ref={ref}>
      <GridLayout
        className="layout"
        layout={layoutFor(widgets, stacked)}
        cols={stacked ? 1 : COLUMNS}
        rowHeight={ROW_HEIGHT}
        width={width}
        margin={[12, 12]}
        isDraggable={!stacked}
        isResizable={!stacked}
        draggableHandle=".tile-head"
        onLayoutChange={(next) => {
          // A stacked layout is a rendering of the real one, not an edit
          // of it. Saving it would flatten everybody's grid the first time
          // they opened home on a phone.
          if (stacked) return;
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
        {widgets.map((widget) => (
          <div key={widget.id} className="widget-cell">
            {widget.available ? (
              <div className="widget-frame">
                <VisualTile
                  visual={
                    widget.title
                      ? { ...widget.visual, title: widget.title }
                      : widget.visual
                  }
                  view={widget.view}
                  selected={false}
                  onSelect={() => {}}
                  reportFilters={widget.reportFilters}
                  pageFilters={widget.pageFilters}
                  hierarchies={widget.hierarchies}
                />
                <div className="widget-footer">
                  <Link className="widget-source" to={`/reports/${widget.reportId}`}>
                    {widget.reportName}
                  </Link>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Unpin ${widget.title ?? widget.visual.title}`}
                    title="Unpin from home"
                    onClick={() => onRemove(widget.id)}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </div>
              </div>
            ) : (
              <DeadTile widget={widget} onRemove={() => onRemove(widget.id)} />
            )}
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
