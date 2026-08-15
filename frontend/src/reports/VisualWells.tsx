import { useDroppable } from "@dnd-kit/core";
import type { Visual } from "../api/types";
import { CATALOG, type FieldKind, type VisualType, type WellSpec } from "./catalog";

interface Props {
  visual: Visual;
  onChange: (next: Visual) => void;
}

function Well({
  spec, refs, onRemove,
}: { spec: WellSpec; refs: string[]; onRemove: (ref: string) => void }) {
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
        <p className="well-hint">Drop a field here</p>
      ) : (
        refs.map((ref) => (
          <span className="chip" key={ref} data-kind={spec.kind}>
            <span className="chip-glyph">{spec.kind === "metric" ? "Σ" : "⬦"}</span>
            <span className="chip-label">{ref}</span>
            <button type="button" className="chip-remove"
                    aria-label={`Remove ${ref}`} onClick={() => onRemove(ref)}>
              &times;
            </button>
          </span>
        ))
      )}
    </section>
  );
}

export default function VisualWells({ visual, onChange }: Props) {
  const spec = CATALOG[visual.type as VisualType];
  return (
    <div className="visual-wells">
      {spec.wells.map((well) => (
        <Well
          key={well.key}
          spec={well}
          refs={visual.wells[well.key] ?? []}
          onRemove={(ref) =>
            onChange({
              ...visual,
              wells: {
                ...visual.wells,
                [well.key]: (visual.wells[well.key] ?? []).filter((r) => r !== ref),
              },
            })
          }
        />
      ))}
    </div>
  );
}
