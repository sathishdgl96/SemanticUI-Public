import { useDroppable } from "@dnd-kit/core";
import FieldChip from "./FieldChip";
import { canDrop, type DragData, type FieldKind, type WellId, type Wells } from "./wells";

// Labelled as a QUERY rather than as a bar chart's anatomy: an explore
// groups and measures, and only sometimes becomes a chart. "Group by" also
// says truthfully that it takes several fields, which "Axis" did not.
const WELLS: { id: WellId; label: string; hint: string; accepts: FieldKind }[] = [
  { id: "axis", label: "Group by", hint: "Drop dimensions here", accepts: "dimension" },
  { id: "legend", label: "Split by", hint: "Optional: one dimension", accepts: "dimension" },
  { id: "values", label: "Measures", hint: "Drop measures here", accepts: "metric" },
];

interface Props {
  wells: Wells;
  onRemove: (wellId: WellId, ref: string) => void;
  onRun: () => void;
  running: boolean;
}

function Well({ id, label, hint, accepts, refs, onRemove }: {
  id: WellId; label: string; hint: string; accepts: FieldKind; refs: string[];
  onRemove: Props["onRemove"];
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id });
  const kind = (active?.data.current as DragData | undefined)?.kind;
  const eligible = kind === undefined || canDrop(id, kind);
  const state = !active ? "" : eligible ? (isOver ? "over" : "eligible") : "blocked";
  return (
    <section ref={setNodeRef} className="well" data-state={state} role="region" aria-label={label}>
      <div className="well-head">
        <h4>{label}</h4>
        {/* Glyph and word share one text run (not a nested span) so this
            declaration never collides with the identical `Σ`/`⬦` glyphs
            FieldChip renders as their own elements elsewhere on the page. */}
        <span className="well-type">{accepts === "metric" ? "Σ metric" : "⬦ dimension"}</span>
      </div>
      {refs.length === 0 ? (
        <p className="well-hint">{hint}</p>
      ) : (
        refs.map((r) => (
          <FieldChip
            key={r}
            refName={r}
            kind={id === "values" ? "metric" : "dimension"}
            wellId={id}
            onRemove={onRemove}
          />
        ))
      )}
    </section>
  );
}

export default function WellPanel({ wells, onRemove, onRun, running }: Props) {
  const total = wells.axis.length + wells.legend.length + wells.values.length;
  return (
    <div className="well-panel">
      {WELLS.map((w) => (
        <Well key={w.id} {...w} refs={wells[w.id]} onRemove={onRemove} />
      ))}
      <button onClick={onRun} disabled={total === 0 || running}>
        {running ? "Running..." : "Run"}
      </button>
    </div>
  );
}
