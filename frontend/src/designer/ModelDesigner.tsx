import { useEffect, useMemo, useState } from "react";
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
import type { CompositeDefinition } from "../api/composites";
import type { CompositeViewDetail } from "../models/availability";
import { MANY, ONE } from "../model/graph";
import Backdrop from "./Backdrop";
import DesignerTable from "./DesignerTable";
import { buildDesigner } from "./layout";

const nodeTypes = { backdrop: Backdrop, designerTable: DesignerTable };

/** Fit, but never past the point where a column row stops being readable
 *  -- the same floor the report diagram keeps, and for the same reason. */
const FIT = { padding: 0.14, minZoom: 0.45, maxZoom: 1 };

/** Which views are open, remembered per model. How somebody reads a
 *  diagram is a fact about them, not about the model, so it does not go
 *  in the definition where it would travel to everyone who opens it. */
function useExpanded(modelId: string) {
  const key = `model.designer.expanded.${modelId}`;
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.map(String) : []);
    } catch {
      // A hand-edited or stale entry must not stop the canvas rendering.
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify([...open]));
    } catch {
      // A full or blocked store is not a reason to fail a render.
    }
  }, [key, open]);

  const toggle = (alias: string) =>
    setOpen((current) => {
      const next = new Set(current);
      const id = alias.toLowerCase();
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return { open, toggle, setOpen };
}

/** Crow's foot, shared with the report diagram's definitions. Drawn here
 *  too because a marker belongs to the SVG that references it. */
function Markers() {
  return (
    <svg className="model-defs" aria-hidden="true">
      <defs>
        <marker
          id={MANY}
          viewBox="0 0 14 14"
          refX="13"
          refY="7"
          markerWidth="14"
          markerHeight="14"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 13 7 L 1 1 M 13 7 L 1 7 M 13 7 L 1 13" className="model-marker" />
        </marker>
        <marker
          id={ONE}
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
    </svg>
  );
}

function Toolbar({
  onExpandAll,
  onCollapseAll,
}: {
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="model-tools" role="toolbar" aria-label="Designer view">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomIn()}>
        +
      </button>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomOut()}>
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
      <button type="button" title="Show every view's tables" onClick={onExpandAll}>
        Expand all
      </button>
      <button type="button" title="Collapse every view" onClick={onCollapseAll}>
        Collapse all
      </button>
    </div>
  );
}

function Canvas({
  modelId,
  definition,
  detail,
}: {
  modelId: string;
  definition: CompositeDefinition;
  detail: CompositeViewDetail;
}) {
  const { open, toggle, setOpen } = useExpanded(modelId);

  const graph = useMemo(
    () => buildDesigner(definition, detail, open),
    [definition, detail, open],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    // Expanding changes every position, so the view is refitted rather
    // than leaving the reader looking at where the diagram used to be.
    const id = window.setTimeout(() => fitView(FIT), 0);
    return () => window.clearTimeout(id);
  }, [graph, setNodes, setEdges, fitView]);

  return (
    <div
      className="designer-canvas"
      // Expansion is driven from the header button inside a node, which
      // React Flow renders; catching the click here keeps the node
      // component free of callbacks it would have to be handed.
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>(
          ".designer-toggle",
        );
        if (button?.dataset.alias) toggle(button.dataset.alias);
      }}
    >
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      </ReactFlow>
      <Toolbar
        onExpandAll={() =>
          setOpen(new Set(definition.members.map((m) => m.alias.toLowerCase())))
        }
        onCollapseAll={() => setOpen(new Set())}
      />
    </div>
  );
}

/**
 * The model as a diagram: member views as coloured areas, their tables
 * inside them, conformed dimensions drawn between the columns they relate.
 *
 * Read-only for now — pan, zoom, expand and collapse. Drawing and editing
 * relationships is the next step; the gestures it will use already exist
 * as pure functions in `edits.ts`.
 */
export default function ModelDesigner({
  modelId,
  definition,
  detail,
  loading,
}: {
  modelId: string;
  definition: CompositeDefinition;
  detail?: CompositeViewDetail;
  loading?: boolean;
}) {
  if (definition.members.length === 0) {
    return (
      <p className="empty">
        Add a view on the Fields tab and it will appear here.
      </p>
    );
  }
  if (loading || !detail) {
    return <p className="tile-hint">Reading the views…</p>;
  }
  return (
    <ReactFlowProvider>
      <Canvas modelId={modelId} definition={definition} detail={detail} />
    </ReactFlowProvider>
  );
}
