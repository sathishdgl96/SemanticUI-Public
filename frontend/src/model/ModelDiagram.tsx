import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SemanticViewDetail } from "../api/types";
import { layoutModel, type ModelNode } from "./layout";
import { fitTo, IDENTITY, zoomAbout, type Viewport } from "./viewport";

/** Where a node has been dragged to, in diagram coordinates. */
type Overrides = Record<string, { x: number; y: number }>;

interface Drag {
  kind: "pan" | "node";
  table?: string;
  pointerId: number;
  fromPointer: { x: number; y: number };
  fromPosition: { x: number; y: number };
}

/** Where an edge meets a card: the middle of whichever side faces the
 *  other card. Anchoring to the centre instead would run the line under
 *  the card and hide the crow's foot behind it. */
function anchor(from: ModelNode, to: ModelNode) {
  const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCentre.x - fromCentre.x;
  const dy = toCentre.y - fromCentre.y;
  // Side or top/bottom, by which separation dominates.
  if (Math.abs(dx) * from.height >= Math.abs(dy) * from.width) {
    return {
      x: dx >= 0 ? from.x + from.width : from.x,
      y: fromCentre.y,
    };
  }
  return {
    x: fromCentre.x,
    y: dy >= 0 ? from.y + from.height : from.y,
  };
}

/**
 * The model as an interactive ER diagram: pan, zoom, fit, and drag a
 * table where you want it.
 *
 * Edges run from the foreign-key side to the referenced side and carry
 * crow's-foot notation — many at the foreign key, one at the referenced
 * key. That is not a guess: a semantic view's relationship declares a
 * foreign key against a referenced key, which is many-to-one by
 * construction, and it is the direction `app/semantic/joins.py` reasons
 * over when deciding whether a field combination is answerable.
 * Snowflake reports no cardinality of its own, so one-to-one is never
 * claimed.
 */
export default function ModelDiagram({
  detail,
  selected,
  onSelect,
}: {
  detail: SemanticViewDetail;
  selected: string | null;
  onSelect: (table: string | null) => void;
}) {
  const layout = useMemo(() => layoutModel(detail), [detail]);
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const positioned = useMemo(
    () => layout.nodes.map((node) => ({ ...node, ...(overrides[node.name] ?? {}) })),
    [layout.nodes, overrides],
  );
  const at = useMemo(() => new Map(positioned.map((n) => [n.name, n])), [positioned]);

  /** Pointer position relative to the pane, the space the viewport
   *  transform is expressed in. */
  const panepoint = (event: { clientX: number; clientY: number }) => {
    const box = paneRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const fit = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    setViewport(fitTo(layout, { width: pane.clientWidth, height: pane.clientHeight }));
  }, [layout]);

  // Fit when the model changes, so a newly opened view arrives framed
  // rather than cropped into a corner. Dragging done to the previous
  // model belonged to that model.
  useLayoutEffect(() => {
    setOverrides({});
    fit();
  }, [fit]);

  // Re-fit when the pane changes size. Collapsing a side pane hands the
  // diagram a much larger box, and without this it keeps the scale it
  // was fitted at and simply sits in the corner of the new space.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(pane);
    return () => observer.disconnect();
  }, [fit]);

  const startPan = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    setDrag({
      kind: "pan",
      pointerId: event.pointerId,
      fromPointer: panepoint(event),
      fromPosition: { x: viewport.x, y: viewport.y },
    });
  };

  const startNodeDrag = (event: React.PointerEvent, node: ModelNode) => {
    if (event.button !== 0) return;
    // Or the pane would pan at the same time as the card moves.
    event.stopPropagation();
    setDrag({
      kind: "node",
      table: node.name,
      pointerId: event.pointerId,
      fromPointer: panepoint(event),
      fromPosition: { x: node.x, y: node.y },
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = panepoint(event);
    const dx = now.x - drag.fromPointer.x;
    const dy = now.y - drag.fromPointer.y;
    if (drag.kind === "pan") {
      setViewport((current) => ({
        ...current,
        x: drag.fromPosition.x + dx,
        y: drag.fromPosition.y + dy,
      }));
      return;
    }
    // Ten screen pixels at half zoom is twenty diagram units.
    setOverrides((current) => ({
      ...current,
      [drag.table as string]: {
        x: drag.fromPosition.x + dx / viewport.scale,
        y: drag.fromPosition.y + dy / viewport.scale,
      },
    }));
  };

  const endDrag = () => setDrag(null);

  const onWheel = (event: React.WheelEvent) =>
    setViewport((current) =>
      zoomAbout(current, event.deltaY < 0 ? 1.1 : 1 / 1.1, panepoint(event)),
    );

  const zoom = (factor: number) => {
    const pane = paneRef.current;
    const centre = {
      x: (pane?.clientWidth ?? 0) / 2,
      y: (pane?.clientHeight ?? 0) / 2,
    };
    setViewport((current) => zoomAbout(current, factor, centre));
  };

  if (layout.nodes.length === 0) {
    return <p className="tile-hint">This view declares no tables.</p>;
  }

  const edges = layout.edges.flatMap((edge) => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to) return [];
    const start = anchor(from, to);
    const end = anchor(to, from);
    return [
      {
        name: edge.name,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        on: selected === edge.from || selected === edge.to,
      },
    ];
  });

  return (
    <div className="model-canvas">
      <div className="model-toolbar" role="toolbar" aria-label="Diagram view">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1.2)}>
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoom(1 / 1.2)}
        >
          −
        </button>
        <button type="button" aria-label="Fit to screen" title="Fit to screen" onClick={fit}>
          ⤢
        </button>
        <span className="model-zoom-level">{Math.round(viewport.scale * 100)}%</span>
        <span className="model-legend">
          <span className="model-swatch kind-fact" aria-hidden="true" /> fact
          <span className="model-swatch kind-dimension" aria-hidden="true" /> dimension
          <span className="model-legend-note">⋯ many → one ⊣</span>
        </span>
      </div>

      {layout.edges.length === 0 && (
        <p className="tile-hint">This model declares no joins between its tables.</p>
      )}

      <div
        className={drag?.kind === "pan" ? "model-pane grabbing" : "model-pane"}
        ref={paneRef}
        onPointerDown={startPan}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <svg className="model-svg" role="group" aria-label="Semantic model diagram">
          <defs>
            {/* Crow's foot: the MANY end, at the foreign key. Drawn
                pointing back down the line, which is what
                auto-start-reverse means on a marker-start. */}
            <marker
              id="model-many"
              viewBox="0 0 14 14"
              refX="13"
              refY="7"
              markerWidth="14"
              markerHeight="14"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path
                d="M 13 7 L 1 1 M 13 7 L 1 7 M 13 7 L 1 13"
                className="model-marker"
              />
            </marker>
            {/* A single bar: the ONE end, at the referenced key. */}
            <marker
              id="model-one"
              viewBox="0 0 14 14"
              refX="4"
              refY="7"
              markerWidth="14"
              markerHeight="14"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 4 1 L 4 13" className="model-marker" />
            </marker>
          </defs>

          <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
            {edges.map((edge) => (
              <g
                key={edge.name}
                data-edge={edge.name}
                className={edge.on ? "model-edge-group on" : "model-edge-group"}
              >
                <title>{edge.name}</title>
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  className="model-edge"
                  markerStart="url(#model-many)"
                  markerEnd="url(#model-one)"
                />
                {edge.on && (
                  <text
                    x={(edge.x1 + edge.x2) / 2}
                    y={(edge.y1 + edge.y2) / 2 - 7}
                    className="model-edge-label"
                    textAnchor="middle"
                  >
                    {edge.name}
                  </text>
                )}
              </g>
            ))}

            {positioned.map((node) => (
              <g
                key={node.name}
                transform={`translate(${node.x}, ${node.y})`}
                onPointerDown={(event) => startNodeDrag(event, node)}
              >
                {/* foreignObject so a card is a real button: focusable,
                    announced, and keyboard-operable without reimplementing
                    any of that on an SVG shape. */}
                <foreignObject width={node.width} height={node.height}>
                  <button
                    type="button"
                    className={[
                      "model-node",
                      `kind-${node.kind}`,
                      selected === node.name ? "selected" : "",
                    ].join(" ").trim()}
                    aria-pressed={selected === node.name}
                    onClick={() => onSelect(selected === node.name ? null : node.name)}
                  >
                    <span className="model-node-head">
                      <span className="model-node-name">{node.name}</span>
                      <span className="model-node-count">{node.fieldCount}</span>
                    </span>
                    {node.columns.length > 0 && (
                      <span className="model-node-columns">
                        {node.columns.map((column) => (
                          <span
                            key={column.name}
                            className={
                              column.key
                                ? `model-column is-key kind-${column.kind}`
                                : `model-column kind-${column.kind}`
                            }
                          >
                            <span className="model-column-name">
                              {column.key && (
                                <span className="model-key" aria-label="join key">
                                  ⚿
                                </span>
                              )}
                              {column.name}
                            </span>
                            <span className="model-column-type">
                              {shortType(column.dataType)}
                            </span>
                          </span>
                        ))}
                        {node.hiddenColumns > 0 && (
                          <span className="model-column more">
                            +{node.hiddenColumns} more
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                </foreignObject>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** `VARCHAR(16777216)` is noise in a card this size; the type family is
 *  the part that tells you what a column is. */
function shortType(dataType: string | null): string {
  if (!dataType) return "";
  return dataType.split("(")[0].toUpperCase().slice(0, 8);
}
