import GridLayout, { type Layout } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type {
  CanvasSettings,
  Filter,
  Hierarchy,
  ViewRef,
  Visual,
  VisualLayout,
} from "../api/types";
import type { CrossFilter, DrillState } from "./filters";
import VisualTile from "./VisualTile";
import ContextMenu, { useContextMenu, type MenuItem } from "../ui/ContextMenu";

interface Props {
  visuals: Visual[];
  canvas: CanvasSettings;
  view: ViewRef;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutChange: (next: Record<string, VisualLayout>) => void;
  readOnly?: boolean;
  reportFilters?: Filter[];
  pageFilters?: Filter[];
  hierarchies?: Hierarchy[];
  /** Drill position per visual id. Ephemeral -- see DrillState. */
  drill?: Record<string, DrillState>;
  onDrill?: (visualId: string, next: DrillState | undefined) => void;
  crossFilter?: CrossFilter | null;
  onCrossFilter?: (next: CrossFilter | null) => void;
  /** Ticked slicer values, keyed by field ref. Ephemeral, like drill. */
  slicerSelections?: Record<string, string[]>;
  onSlicerChange?: (field: string, values: string[]) => void;
  /** Refs the view exposes as raw FACTS. */
  factRefs?: string[];
  /** Right-click actions on a visual. Absent in read-only contexts, where
   *  there is nothing to pin from and nothing to delete. */
  onDeleteVisual?: (visualId: string) => void;
  onPinVisual?: (visualId: string) => void;
}

/** Width is measured rather than assumed so the grid tracks the pane it sits in. */
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

/** Below this the 12-column grid stops being a layout and starts being a
 *  column of slivers: a half-width tile on a 390px phone is under 180px,
 *  which no chart can say anything in. */
const STACK_BELOW = 640;

/** Minimum rows a stacked tile gets, so a KPI card does not collapse to a
 *  line of text and a chart keeps a drawable aspect ratio. */
const MIN_STACKED_ROWS = 6;

/** The grid layout to draw: the author's own arrangement, or -- on a narrow
 *  screen -- a single column in the reading order that arrangement implies
 *  (top to bottom, then left to right). */
export function layoutFor(visuals: Visual[], stacked: boolean): Layout[] {
  if (!stacked) {
    return visuals.map((v) => ({
      i: v.id, x: v.layout.x, y: v.layout.y, w: v.layout.w, h: v.layout.h, minW: 2, minH: 3,
    }));
  }
  return [...visuals]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .reduce<Layout[]>((rows, v) => {
      const h = Math.max(v.layout.h, MIN_STACKED_ROWS);
      const y = rows.reduce((sum, r) => sum + r.h, 0);
      // `static`, not merely undraggable: on a touch screen a drag IS the
      // scroll gesture, and letting the grid claim it traps the page.
      rows.push({ i: v.id, x: 0, y, w: 1, h, static: true });
      return rows;
    }, []);
}

/** The report's own canvas colour, or nothing. Only hex reaches the style
 *  attribute -- the server validates this field against the same shape, and a
 *  saved document is still not a trusted source. */
function canvasStyle(canvas: CanvasSettings): React.CSSProperties | undefined {
  const background = canvas.background;
  return typeof background === "string" &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(background)
    ? { background }
    : undefined;
}

export default function CanvasGrid({
  visuals, canvas, view, selectedId, onSelect, onLayoutChange, readOnly = false,
  reportFilters = [], pageFilters = [], hierarchies = [], drill = {}, onDrill,
  crossFilter = null, onCrossFilter,
  slicerSelections = {}, onSlicerChange, factRefs = [],
  onDeleteVisual, onPinVisual,
}: Props) {
  const { ref, width } = useMeasuredWidth();
  const menu = useContextMenu();
  const [menuTarget, setMenuTarget] = useState<Visual | null>(null);

  if (visuals.length === 0) {
    return (
      <div className="canvas empty" ref={ref} style={canvasStyle(canvas)}>
        <p className="tile-hint">Add a visual from the Visualizations pane to begin.</p>
      </div>
    );
  }

  // On a phone the grid becomes a single stacked column, in the reading order
  // the desktop layout implies (top to bottom, then left to right).
  const stacked = width < STACK_BELOW;

  const layout = layoutFor(visuals, stacked);

  /** What right-clicking a visual offers. An action the caller did not
   *  supply is absent rather than dead: on a read-only report there is
   *  nothing to pin from and nothing to delete. */
  const contextItems = (visual: Visual): MenuItem[] => {
    const items: MenuItem[] = [];
    if (onPinVisual) {
      items.push({
        id: "pin",
        label: "Pin to dashboard…",
        icon: "pin",
        disabledReason: readOnly
          ? "Save the report first — a tile names the saved report."
          : undefined,
        onSelect: () => onPinVisual(visual.id),
      });
    }
    if (onDeleteVisual) {
      items.push({
        id: "delete",
        label: "Delete visual",
        icon: "trash",
        danger: true,
        separatorBefore: items.length > 0,
        disabledReason: readOnly ? "You cannot edit this report." : undefined,
        onSelect: () => onDeleteVisual(visual.id),
      });
    }
    return items;
  };

  return (
    <div
      className={stacked ? "canvas stacked" : "canvas"}
      ref={ref}
      style={canvasStyle(canvas)}
      // Clicking the canvas ITSELF deselects -- PowerBI's behaviour, and
      // until this existed the page-level format section was unreachable:
      // once a visual was selected there was no way to select nothing.
      // `e.target === e.currentTarget` so a click that landed on a tile and
      // bubbled up here does not immediately undo the selection it made.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onSelect("");
      }}
    >
      <GridLayout
        className="layout"
        layout={layout}
        cols={stacked ? 1 : canvas.columns}
        rowHeight={canvas.rowHeight}
        width={width}
        margin={[12, 12]}
        isDraggable={!readOnly && !stacked}
        isResizable={!readOnly && !stacked}
        draggableHandle=".tile-head"
        onLayoutChange={(next) => {
          // Never write the phone stacking back to the definition. The
          // stacked layout is a rendering of the real one, not a replacement
          // for it -- saving it would silently flatten the author's desktop
          // arrangement the first time they opened the report on a phone.
          if (readOnly || stacked) return;
          const mapped: Record<string, VisualLayout> = {};
          for (const item of next) {
            mapped[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
          }
          onLayoutChange(mapped);
        }}
      >
        {visuals.map((visual) => (
          <div
            key={visual.id}
            onContextMenu={(event) => {
              // Selecting first, so the menu's actions and the panes on the
              // right are talking about the same visual.
              onSelect(visual.id);
              setMenuTarget(visual);
              menu.open(event);
            }}
          >
            <VisualTile
              visual={visual}
              view={view}
              selected={selectedId === visual.id}
              onSelect={onSelect}
              reportFilters={reportFilters}
              pageFilters={pageFilters}
              hierarchies={hierarchies}
              drill={drill[visual.id]}
              onDrill={onDrill ? (next) => onDrill(visual.id, next) : undefined}
              crossFilter={crossFilter}
              onCrossFilter={onCrossFilter}
              slicerSelections={slicerSelections}
              onSlicerChange={onSlicerChange}
              factRefs={factRefs}
            />
          </div>
        ))}
      </GridLayout>

      {menu.at && menuTarget && (
        <ContextMenu
          at={menu.at}
          items={contextItems(menuTarget)}
          onClose={menu.close}
        />
      )}
    </div>
  );
}
