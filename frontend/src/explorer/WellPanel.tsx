import { useDroppable } from "@dnd-kit/core";
import FieldChip from "./FieldChip";
import { canDrop, type DragData, type WellId, type Wells } from "./wells";

const WELLS: { id: WellId; label: string; hint: string }[] = [
  { id: "axis", label: "Axis", hint: "Drop a field here" },
  { id: "legend", label: "Legend", hint: "Drop a field here" },
  { id: "values", label: "Values", hint: "Drop a field here" },
];

interface Props {
  wells: Wells;
  onRemove: (wellId: WellId, ref: string) => void;
  onRun: () => void;
  running: boolean;
}

function Well({ id, label, hint, refs, onRemove }: {
  id: WellId; label: string; hint: string; refs: string[];
  onRemove: Props["onRemove"];
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id });
  const kind = (active?.data.current as DragData | undefined)?.kind;
  const accepts = kind === undefined || canDrop(id, kind);
  const state = !active ? "" : accepts ? (isOver ? "over" : "eligible") : "blocked";
  return (
    <section ref={setNodeRef} className="well" data-state={state} aria-label={label}>
      <h4>{label}</h4>
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
