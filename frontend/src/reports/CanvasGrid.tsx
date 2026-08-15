import GridLayout, { type Layout } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { CanvasSettings, ViewRef, Visual, VisualLayout } from "../api/types";
import VisualTile from "./VisualTile";

interface Props {
  visuals: Visual[];
  canvas: CanvasSettings;
  view: ViewRef;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutChange: (next: Record<string, VisualLayout>) => void;
  readOnly?: boolean;
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

export default function CanvasGrid({
  visuals, canvas, view, selectedId, onSelect, onLayoutChange, readOnly = false,
}: Props) {
  const { ref, width } = useMeasuredWidth();

  if (visuals.length === 0) {
    return (
      <div className="canvas empty" ref={ref}>
        <p className="tile-hint">Add a visual from the Visualizations pane to begin.</p>
      </div>
    );
  }

  const layout: Layout[] = visuals.map((v) => ({
    i: v.id, x: v.layout.x, y: v.layout.y, w: v.layout.w, h: v.layout.h, minW: 2, minH: 3,
  }));

  return (
    <div className="canvas" ref={ref}>
      <GridLayout
        className="layout"
        layout={layout}
        cols={canvas.columns}
        rowHeight={canvas.rowHeight}
        width={width}
        margin={[12, 12]}
        isDraggable={!readOnly}
        isResizable={!readOnly}
        draggableHandle=".tile-head"
        onLayoutChange={(next) => {
          if (readOnly) return;
          const mapped: Record<string, VisualLayout> = {};
          for (const item of next) {
            mapped[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
          }
          onLayoutChange(mapped);
        }}
      >
        {visuals.map((visual) => (
          <div key={visual.id}>
            <VisualTile
              visual={visual}
              view={view}
              selected={selectedId === visual.id}
              onSelect={onSelect}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
