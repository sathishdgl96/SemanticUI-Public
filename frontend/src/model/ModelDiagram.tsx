import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SemanticViewDetail } from "../api/types";
import {
  buildGraph,
  MANY,
  ONE,
  type ModelEdge,
  type TableNode as TableNodeType,
} from "./graph";
import { highlightFor } from "./relatedness";
import TableNode, { ModelNodeContext } from "./TableNode";

const nodeTypes = { table: TableNode };

/** Fit, but never past the point where a column row stops being readable.
 *  Past that the reader is better served by a scrollable diagram at a
 *  size they can read than by a complete one they cannot. */
const FIT = { padding: 0.12, minZoom: 0.55, maxZoom: 1 };

/** Crow's foot, drawn twice: once in the line colour and once in the
 *  accent, because a marker is a shared definition and cannot take its
 *  colour from the edge that references it. */
function Markers() {
  return (
    <svg className="model-defs" aria-hidden="true">
      <defs>
        {[
          { suffix: "", className: "model-marker" },
          { suffix: "-on", className: "model-marker on" },
        ].map(({ suffix, className }) => (
          <g key={suffix || "base"}>
            {/* The MANY end, at the foreign key. Drawn pointing back down
                the line, which is what auto-start-reverse means on a
                marker-start. */}
            <marker
              id={`${MANY}${suffix}`}
              viewBox="0 0 14 14"
              refX="13"
              refY="7"
              markerWidth="14"
              markerHeight="14"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 13 7 L 1 1 M 13 7 L 1 7 M 13 7 L 1 13" className={className} />
            </marker>
            {/* A single bar: the ONE end, at the referenced key. */}
            <marker
              id={`${ONE}${suffix}`}
              viewBox="0 0 14 14"
              refX="4"
              refY="7"
              markerWidth="14"
              markerHeight="14"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 4 1 L 4 13" className={className} />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}

/** Zoom and fit, ours rather than React Flow's `<Controls>`.
 *
 *  Its buttons carry a near-white face, a near-white divider and a pale
 *  drop shadow from three separate rules, and it colours its icons from
 *  an inherited `color` -- which on this canvas came out as a white box
 *  with nothing visible in it. Three buttons is less code than reliably
 *  overriding all of that. */
function Toolbar() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="model-tools" role="toolbar" aria-label="Diagram view">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomIn()}>
        +
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => zoomOut()}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Fit to screen"
        title="Fit to screen"
        onClick={() => fitView(FIT)}
      >
        ⤢
      </button>
    </div>
  );
}

export interface ModelDiagramProps {
  detail: SemanticViewDetail;
  /** The selected field, `TABLE.NAME`, or null. */
  selectedRef: string | null;
  selectedTable: string | null;
  onSelectField: (ref: string) => void;
  onSelectTable: (table: string) => void;
}

/**
 * The model as an interactive ER diagram.
 *
 * Pan, zoom, drag-a-table and fit come from React Flow rather than from
 * this file. What is ours is the layout (dagre, in `graph.ts`), the cards,
 * and the fact that a join edge anchors to the key column it is declared
 * on -- which is what makes clicking a column able to say anything about
 * how it reaches the rest of the model.
 */
function Diagram({
  detail,
  selectedRef,
  selectedTable,
  onSelectField,
  onSelectTable,
}: ModelDiagramProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ModelEdge>([]);
  const { fitView } = useReactFlow();

  const graph = useMemo(() => buildGraph(detail, expanded), [detail, expanded]);

  // A table expanded in one model has no meaning in another.
  useEffect(() => {
    setExpanded(new Set());
  }, [detail]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    // Positions changed under the viewport, so the previous framing is
    // no longer the framing of anything. requestAnimationFrame because
    // React Flow measures on the next frame.
    const frame = requestAnimationFrame(() => fitView(FIT));
    return () => cancelAnimationFrame(frame);
  }, [graph, setNodes, setEdges, fitView]);

  const highlight = useMemo(
    () => highlightFor(detail, selectedRef),
    [detail, selectedRef],
  );

  const toggleExpand = useCallback((table: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }, []);

  const context = useMemo(
    () => ({
      selectedRef,
      selectedTable,
      states: highlight?.tables ?? null,
      onSelectField,
      onSelectTable,
      onToggleExpand: toggleExpand,
    }),
    [selectedRef, selectedTable, highlight, onSelectField, onSelectTable, toggleExpand],
  );

  // Edges carry the highlight rather than the nodes carrying it for them:
  // an edge is on a path or it is not, and that is decided per selection,
  // not per layout.
  const painted = useMemo(
    () =>
      edges.map((edge) => {
        const on = highlight?.relationships.has(edge.id) ?? false;
        return {
          ...edge,
          className: highlight ? (on ? "model-edge on" : "model-edge off") : "model-edge",
          markerStart: on ? `${MANY}-on` : MANY,
          markerEnd: on ? `${ONE}-on` : ONE,
          label: on ? edge.data?.on : undefined,
        };
      }),
    [edges, highlight],
  );

  if (graph.nodes.length === 0) {
    return <p className="tile-hint">This view declares no tables.</p>;
  }

  return (
    <div className="model-canvas">
      {graph.edges.length === 0 && (
        <p className="tile-hint">This model declares no joins between its tables.</p>
      )}

      <Markers />

      <ModelNodeContext.Provider value={context}>
        <div className="model-pane">
          <ReactFlow
            nodes={nodes}
            edges={painted}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={FIT}
            minZoom={0.15}
            maxZoom={2.5}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: false }}
            aria-label="Semantic model diagram"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          </ReactFlow>
          <Toolbar />
        </div>
      </ModelNodeContext.Provider>

      <p className="model-legend">
        <span className="model-swatch kind-fact" aria-hidden="true" /> references another
        table
        <span className="model-swatch kind-dimension" aria-hidden="true" /> referenced only
        <span className="model-legend-note">⋯ many → one ⊣</span>
        <span className="model-legend-note">Click a column to see what it reaches.</span>
      </p>
    </div>
  );
}

export default function ModelDiagram(props: ModelDiagramProps) {
  // useReactFlow needs a provider above it, and the provider is what owns
  // the viewport -- so it has to sit outside the component that fits it.
  return (
    <ReactFlowProvider>
      <Diagram {...props} />
    </ReactFlowProvider>
  );
}
