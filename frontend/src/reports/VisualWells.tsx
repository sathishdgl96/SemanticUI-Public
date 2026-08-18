import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { Visual } from "../api/types";
import {
  AGGREGATIONS,
  CATALOG,
  DEFAULT_AGGREGATION,
  type FieldKind,
  type VisualType,
  type WellSpec,
} from "./catalog";

interface Props {
  visual: Visual;
  onChange: (next: Visual) => void;
  /** Refs the view exposes as raw FACTS; those get an aggregation picker. */
  factRefs?: string[];
}

/** One field chip: draggable by its handle so it can be reordered within
 *  its well or moved to another well of the same kind, and a drop target so
 *  a dragged chip can land IN FRONT of it. The handle carries the listeners
 *  rather than the whole chip -- the remove button and the aggregation
 *  picker have to stay ordinary clicks. */
function WellChip({
  wellKey, refName, kind, children,
}: {
  wellKey: string;
  refName: string;
  kind: FieldKind;
  children: React.ReactNode;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `chip:${wellKey}:${refName}`,
    data: { ref: refName, kind, fromWell: wellKey, chip: true },
  });
  const drop = useDroppable({
    id: `chipdrop:${wellKey}:${refName}`,
    data: { ref: refName, well: wellKey },
  });
  return (
    <span
      className="chip"
      data-kind={kind}
      data-dragging={isDragging || undefined}
      data-drop={drop.isOver || undefined}
      ref={(el) => {
        setNodeRef(el);
        drop.setNodeRef(el);
      }}
    >
      <button
        type="button"
        className="chip-handle"
        aria-label={`Reorder ${refName}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      {children}
    </span>
  );
}


function Well({
  spec, refs, onRemove, factRefs, aggregations, onAggregationChange,
}: {
  spec: WellSpec;
  refs: string[];
  onRemove: (ref: string) => void;
  factRefs: Set<string>;
  aggregations: Record<string, string>;
  onAggregationChange: (ref: string, fn: string) => void;
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `well:${spec.key}` });
  const draggedKind = active?.data.current?.kind as FieldKind | undefined;
  const accepts = draggedKind === undefined || draggedKind === spec.kind;
  const full = spec.max !== null && refs.length >= spec.max;
  const state = !active ? "" : accepts && !full ? (isOver ? "over" : "eligible") : "blocked";

  return (
    <section ref={setNodeRef} role="region" aria-label={spec.label}
             className="well" data-state={state}>
      <div className="well-head">
        <h4>{spec.label}</h4>
        <span className="well-type">
          {spec.kind === "metric" ? "Σ metric" : "⬦ dimension"}
        </span>
      </div>
      {refs.length === 0 ? (
        <p className="well-hint">Add data fields here</p>
      ) : (
        refs.map((ref) => {
          // A raw fact carries no aggregation of its own, so the visual has to
          // say which one to apply -- exactly the choice PowerBI puts on the
          // field's own menu. A view-defined metric already knows, and offering
          // the choice there would imply it could be overridden.
          const isFact = factRefs.has(ref.toUpperCase());
          return (
            <WellChip key={ref} wellKey={spec.key} refName={ref} kind={spec.kind}>
              <span className="chip-glyph">{spec.kind === "metric" ? "Σ" : "⬦"}</span>
              <span className="chip-label">{ref}</span>
              {isFact && (
                <select
                  className="chip-aggregation"
                  aria-label={`Aggregation for ${ref}`}
                  value={aggregations[ref] ?? DEFAULT_AGGREGATION}
                  onChange={(e) => onAggregationChange(ref, e.target.value)}
                >
                  {AGGREGATIONS.map((a) => (
                    <option key={a.fn} value={a.fn}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="chip-remove"
                      aria-label={`Remove ${ref}`} onClick={() => onRemove(ref)}>
                &times;
              </button>
            </WellChip>
          );
        })
      )}
    </section>
  );
}

export default function VisualWells({ visual, onChange, factRefs = [] }: Props) {
  const spec = CATALOG[visual.type as VisualType];
  const facts = new Set(factRefs.map((r) => r.toUpperCase()));
  const aggregations = (visual.options.aggregations ?? {}) as Record<string, string>;

  return (
    <div className="visual-wells">
      {spec.wells.map((well) => (
        <Well
          key={well.key}
          spec={well}
          refs={visual.wells[well.key] ?? []}
          factRefs={facts}
          aggregations={aggregations}
          onAggregationChange={(ref, fn) =>
            onChange({
              ...visual,
              options: { ...visual.options, aggregations: { ...aggregations, [ref]: fn } },
            })
          }
          onRemove={(ref) => {
            // The aggregation goes with the field. Leaving it behind would
            // put a setting in the saved document for a field the visual no
            // longer holds, and quietly restore it if the field came back.
            const { [ref]: _dropped, ...remaining } = aggregations;
            onChange({
              ...visual,
              wells: {
                ...visual.wells,
                [well.key]: (visual.wells[well.key] ?? []).filter((r) => r !== ref),
              },
              options: { ...visual.options, aggregations: remaining },
            });
          }}
        />
      ))}
    </div>
  );
}
