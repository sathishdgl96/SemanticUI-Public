import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ConnectionMode,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CompositeDefinition } from "../api/composites";
import type { CompositeViewDetail } from "../models/availability";
import type { SemanticViewDetail, SemanticViewSummary } from "../api/types";
import { MANY, ONE } from "../model/graph";
import Backdrop from "./Backdrop";
import DesignerTable from "./DesignerTable";
import { addMember, relate, removeMember, rename, unrelate } from "./edits";
import { buildDesigner, parseHandle, type DesignerEdge } from "./layout";
import { ghostKey, ghostsFor } from "./suggest";

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
    <svg className="designer-defs" aria-hidden="true">
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
          <path d="M 13 7 L 1 1 M 13 7 L 1 7 M 13 7 L 1 13" className="designer-marker" />
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
          <path d="M 4 1 L 4 13" className="designer-marker" />
        </marker>
      </defs>
    </svg>
  );
}

function Toolbar({
  onExpandAll,
  onCollapseAll,
  ghosts,
  onDetectAll,
  readOnly,
  available,
  onAddView,
  maximised,
  onToggleMaximised,
}: {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  ghosts: number;
  onDetectAll: () => void;
  readOnly: boolean;
  available: SemanticViewSummary[];
  onAddView: (view: SemanticViewSummary) => void;
  maximised: boolean;
  onToggleMaximised: () => void;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="designer-tools" role="toolbar" aria-label="Designer view">
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
      {!readOnly && (
        <>
          <label className="sr-only" htmlFor="designer-add-view">
            Add a view
          </label>
          <select
            id="designer-add-view"
            className="designer-add"
            value=""
            onChange={(event) => {
              const picked = available.find(
                (view) =>
                  `${view.database}.${view.schema}.${view.name}` ===
                  event.target.value,
              );
              event.currentTarget.value = "";
              if (picked) onAddView(picked);
            }}
          >
            <option value="">+ Add a view…</option>
            {available.map((view) => {
              const id = `${view.database}.${view.schema}.${view.name}`;
              return (
                <option key={id} value={id}>
                  {id}
                </option>
              );
            })}
          </select>
        </>
      )}
      <button type="button" title="Show every view's tables" onClick={onExpandAll}>
        Expand all
      </button>
      <button type="button" title="Collapse every view" onClick={onCollapseAll}>
        Collapse all
      </button>
      <button
        type="button"
        aria-pressed={maximised}
        title={maximised ? "Leave full screen (Esc)" : "Fill the window"}
        onClick={onToggleMaximised}
      >
        {maximised ? "⤡ Exit full screen" : "⤢ Full screen"}
      </button>
      {!readOnly && ghosts > 0 && (
        <button
          type="button"
          className="primary"
          title="Accept every suggested mapping"
          onClick={onDetectAll}
        >
          Accept {ghosts} suggested
        </button>
      )}
    </div>
  );
}

function Canvas({
  modelId,
  definition,
  detail,
  describes,
  readOnly,
  views,
  onChange,
}: {
  modelId: string;
  definition: CompositeDefinition;
  detail: CompositeViewDetail;
  describes: Record<string, SemanticViewDetail | undefined>;
  readOnly: boolean;
  views: SemanticViewSummary[];
  onChange: (next: CompositeDefinition) => void;
}) {
  const { open, toggle, setOpen } = useExpanded(modelId);
  const [maximised, setMaximised] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesignerEdge | null>(null);

  const ghosts = useMemo(
    () => (readOnly ? [] : ghostsFor(definition, describes, dismissed)),
    [definition, describes, dismissed, readOnly],
  );

  const graph = useMemo(
    () => buildDesigner(definition, detail, open, ghosts),
    [definition, detail, open, ghosts],
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

  // Going full screen changes the pane, not the graph, so React Flow has
  // to be told to fit again -- and after the browser has laid the new
  // size out, or it fits to the old one.
  useEffect(() => {
    const id = window.setTimeout(() => fitView(FIT), 60);
    return () => window.clearTimeout(id);
  }, [maximised, fitView]);

  // Escape leaves, because a canvas that fills the window with no way
  // out but a small button is a trap.
  useEffect(() => {
    if (!maximised) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMaximised(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximised]);

  function apply(result: ReturnType<typeof relate>) {
    if (result.ok) {
      setRefusal(null);
      setSelected(null);
      onChange(result.definition);
    } else {
      // A drag that silently does nothing is worse than one that says
      // why -- the reason is the whole feedback for a gesture that had no
      // visible effect.
      setRefusal(result.reason);
    }
  }

  function onConnect(connection: Connection) {
    // In loose mode either end can be either role, which is fine: both
    // ids encode the same alias/table/column and `relate` decides what
    // the pair means.
    const from = parseHandle(connection.sourceHandle);
    const to = parseHandle(connection.targetHandle);
    if (!from || !to) {
      setRefusal("Drag from a column to a column — that is what a mapping is.");
      return;
    }
    apply(relate(definition, from, to));
  }

  const accepted = (name: string) =>
    ghosts.find((ghost) => ghost.name === name);

  function acceptGhost(name: string) {
    const ghost = accepted(name);
    if (!ghost) return;
    // Through `relate` rather than by appending: a suggestion has to obey
    // the same rules a drag does, or accepting one could save a model the
    // server refuses.
    const entries = Object.entries(ghost.bindings);
    let next = definition;
    for (let i = 0; i + 1 < entries.length; i += 1) {
      const [alias, binding] = entries[i];
      const [nextAlias, nextBinding] = entries[i + 1];
      const result = relate(
        next,
        { alias, table: binding.table, column: binding.column },
        { alias: nextAlias, table: nextBinding.table, column: nextBinding.column },
      );
      if (!result.ok) {
        setRefusal(result.reason);
        return;
      }
      next = result.definition;
    }
    setRefusal(null);
    onChange(next);
  }

  return (
    <div
      className={`designer-canvas${maximised ? " is-maximised" : ""}`}
      // Expansion is driven from the header button inside a node, which
      // React Flow renders; catching the click here keeps the node
      // component free of callbacks it would have to be handed.
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const drop = target.closest<HTMLElement>(".designer-remove");
        if (drop?.dataset.alias) {
          apply(removeMember(definition, drop.dataset.alias));
          return;
        }
        const button = target.closest<HTMLElement>(".designer-toggle");
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
        onConnect={readOnly ? undefined : onConnect}
        onEdgeClick={(_event, edge) => {
          setRefusal(null);
          const kind = (edge as DesignerEdge).data?.kind;
          if (kind === "internal") {
            setSelected(null);
            setRefusal(
              "That join belongs to the view — Snowflake declares it, so it " +
                "cannot be changed here.",
            );
            return;
          }
          setSelected(edge as DesignerEdge);
        }}
        // Loose, not strict: strict only lets a SOURCE handle reach a
        // TARGET one, so dragging between two columns whose ports happen
        // to face away from each other failed silently. A mapping is
        // symmetric -- "these mean the same thing" -- so the gesture
        // should be too.
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={!readOnly}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      </ReactFlow>

      {definition.members.length === 0 && (
        <p className="designer-empty">
          {readOnly
            ? "This model has no views yet."
            : "Add a view to start. Then drag a column onto a column in another view to say they mean the same thing."}
        </p>
      )}

      <Toolbar
        onExpandAll={() =>
          setOpen(new Set(definition.members.map((m) => m.alias.toLowerCase())))
        }
        onCollapseAll={() => setOpen(new Set())}
        ghosts={ghosts.length}
        onDetectAll={() => ghosts.forEach((ghost) => acceptGhost(ghost.name))}
        readOnly={readOnly}
        available={views.filter(
          (view) =>
            !definition.members.some(
              (member) =>
                member.database === view.database &&
                member.schema === view.schema &&
                member.view === view.name,
            ),
        )}
        onAddView={(view) => apply(addMember(definition, view))}
        maximised={maximised}
        onToggleMaximised={() => setMaximised((current) => !current)}
      />

      {refusal && (
        <p className="designer-refusal" role="alert">
          {refusal}
          <button type="button" className="link" onClick={() => setRefusal(null)}>
            Dismiss
          </button>
        </p>
      )}

      {selected?.data?.kind === "conformed" && !readOnly && (
        <div className="designer-edge-panel" role="group" aria-label="Shared dimension">
          <label className="sr-only" htmlFor="designer-edge-name">
            Name
          </label>
          <input
            id="designer-edge-name"
            defaultValue={selected.data.dimension}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              apply(
                rename(
                  definition,
                  selected.data!.dimensionIndex as number,
                  (event.target as HTMLInputElement).value,
                ),
              );
            }}
          />
          <button
            type="button"
            className="danger"
            onClick={() =>
              apply(unrelate(definition, selected.data!.dimensionIndex as number))
            }
          >
            Remove
          </button>
          <button type="button" className="link" onClick={() => setSelected(null)}>
            Close
          </button>
        </div>
      )}

      {selected?.data?.kind === "ghost" && !readOnly && (
        <div className="designer-edge-panel" role="group" aria-label="Suggested mapping">
          <span>
            <strong>{selected.data.dimension}</strong> — {selected.data.reason}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => {
              acceptGhost(selected.data!.dimension as string);
              setSelected(null);
            }}
          >
            Accept
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              const ghost = accepted(selected.data!.dimension as string);
              if (ghost) {
                setDismissed((current) => new Set(current).add(ghostKey(ghost)));
              }
              setSelected(null);
            }}
          >
            Not the same
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The model as a diagram you can edit: member views as coloured areas,
 * their tables inside them, conformed dimensions drawn between the
 * columns they relate.
 *
 * Drag a column onto a column in another view to map them. Suggestions
 * are drawn dashed and are never applied on their own — a mapping the app
 * made is one nobody reviewed.
 */
export default function ModelDesigner({
  modelId,
  definition,
  detail,
  describes,
  loading,
  readOnly = false,
  views = [],
  onChange,
}: {
  modelId: string;
  definition: CompositeDefinition;
  detail?: CompositeViewDetail;
  /** Each member view's own describe, as the page fetched it. The
   *  matcher wants these, and handing them over beats flattening them
   *  into the model's shape only to unflatten them again. */
  describes: Record<string, SemanticViewDetail | undefined>;
  loading?: boolean;
  readOnly?: boolean;
  /** Every semantic view this caller can see, so a model can be built
   *  here without going to the form for its first move. */
  views?: SemanticViewSummary[];
  onChange: (next: CompositeDefinition) => void;
}) {
  if (loading || !detail) {
    return <p className="tile-hint">Reading the views…</p>;
  }
  return (
    <ReactFlowProvider>
      {/* Shown only under the canvas's breakpoint, by CSS rather than by
          measuring: a width query does not need a resize listener, and
          the two cannot disagree about where the cutoff is. */}
      <p className="designer-too-narrow">
        There is not enough width here to draw the model. The Fields tab
        does everything this does, and works at any size.
      </p>
      <Canvas
        modelId={modelId}
        definition={definition}
        detail={detail}
        describes={describes}
        readOnly={readOnly}
        views={views}
        onChange={onChange}
      />
    </ReactFlowProvider>
  );
}
