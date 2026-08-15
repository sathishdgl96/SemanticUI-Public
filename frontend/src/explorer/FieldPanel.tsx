import { useDraggable } from "@dnd-kit/core";
import type { FieldInfo, SemanticViewDetail } from "../api/types";
import { defaultWellFor, type DragData, type FieldKind, type WellId, type Wells } from "./wells";

export type OnAdd = (wellId: WellId, ref: string, kind: FieldKind) => void;

interface Props {
  detail: SemanticViewDetail;
  wells: Wells;
  onAdd: OnAdd;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FieldRow({ field, kind, wells, onAdd }: {
  field: FieldInfo;
  kind: FieldKind;
  wells: Wells;
  onAdd: Props["onAdd"];
}) {
  const ref = refOf(field);
  const data: DragData = { ref, kind };
  // `attributes` already includes an `aria-pressed` that reflects
  // `isDragging` (dnd-kit's own drag-state signal), so it isn't repeated
  // here as a separate prop.
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: ref,
    data,
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      onClick={() => onAdd(defaultWellFor(kind, wells), ref, kind)}
      {...listeners}
      {...attributes}
    >
      <span className="field-glyph">{kind === "metric" ? "Σ" : "⬦"}</span>
      <span>{ref}</span>
      {field.dataType && <small>{field.dataType}</small>}
    </button>
  );
}

function FieldGroup({
  title, kind, fields, wells, onAdd,
}: {
  title: string;
  kind: FieldKind;
  fields: FieldInfo[];
  wells: Wells;
  onAdd: Props["onAdd"];
}) {
  return (
    <section>
      <h4>{title}</h4>
      {fields.map((field) => (
        <FieldRow key={refOf(field)} field={field} kind={kind} wells={wells} onAdd={onAdd} />
      ))}
    </section>
  );
}

export default function FieldPanel({ detail, wells, onAdd }: Props) {
  return (
    <aside className="field-panel">
      <p className="field-hint">
        Enter adds to the default well · Space picks up to drag
      </p>
      <FieldGroup
        title="Dimensions" kind="dimension" fields={detail.dimensions}
        wells={wells} onAdd={onAdd}
      />
      <FieldGroup
        title="Metrics" kind="metric" fields={detail.metrics}
        wells={wells} onAdd={onAdd}
      />
    </aside>
  );
}
