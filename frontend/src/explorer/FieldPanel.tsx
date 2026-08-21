import { useDraggable } from "@dnd-kit/core";
import { useId, useMemo } from "react";
import type { FieldInfo, SemanticViewDetail } from "../api/types";
import { availability } from "./joins";
import { defaultWellFor, type DragData, type FieldKind, type WellId, type Wells } from "./wells";

export type OnAdd = (wellId: WellId, ref: string, kind: FieldKind) => void;

interface Props {
  detail: SemanticViewDetail;
  wells: Wells;
  onAdd: OnAdd;
  /** What cannot be added, and why -- ref -> reason. Supplied by the
   *  caller when the source has its own rules: a model's reachability is
   *  per member, which this view's own join graph cannot express. */
  blocked?: Map<string, string>;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FieldRow({ field, kind, wells, onAdd, blocked, reasonId }: {
  field: FieldInfo;
  kind: FieldKind;
  wells: Wells;
  onAdd: Props["onAdd"];
  /** True when the current selection has ruled this field out. */
  blocked: boolean;
  /** The note that explains why, shared by every field blocked for the same
   *  reason -- see FieldGroup. */
  reasonId?: string;
}) {
  const ref = refOf(field);
  const data: DragData = { ref, kind };
  // `attributes` already includes an `aria-pressed` that reflects
  // `isDragging` (dnd-kit's own drag-state signal), so it isn't repeated
  // here as a separate prop.
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: ref,
    data,
    // A field that cannot be added must not be draggable either, or the drop
    // would succeed where the click was refused.
    disabled: blocked,
  });
  // dnd-kit puts its own `aria-describedby` in `attributes` (pointing at the
  // drag instructions), so the two have to be composed rather than one spread
  // over the other -- which silently dropped this hint when `attributes` was
  // spread last.
  const describedBy = [attributes["aria-describedby"], reasonId]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      disabled={blocked}
      onClick={() => onAdd(defaultWellFor(kind, wells), ref, kind)}
      {...listeners}
      {...attributes}
      aria-describedby={describedBy || undefined}
    >
      <span className="field-glyph">{kind === "metric" ? "Σ" : "⬦"}</span>
      {/* The pane is resizable, but a name can still outrun any width a
          person wants to give it -- so the full one is always one hover
          (or one focus, for the tooltip's a11y equivalent) away. */}
      <span className="field-ref" title={ref}>
        {ref}
      </span>
      {field.dataType && <small>{field.dataType}</small>}
    </button>
  );
}

function FieldGroup({
  title, kind, fields, wells, onAdd, blocked,
}: {
  title: string;
  kind: FieldKind;
  fields: FieldInfo[];
  wells: Wells;
  onAdd: Props["onAdd"];
  blocked: Map<string, string>;
}) {
  const groupId = useId();
  // One note per distinct reason, at the head of the group -- not one under
  // every row. A dozen fields ruled out by a single measure produced a dozen
  // identical three-line explanations, which buried the two fields that were
  // still available under the reasons the rest were not.
  const reasons = useMemo(() => {
    const seen: string[] = [];
    for (const field of fields) {
      const reason = blocked.get(refOf(field));
      if (reason && !seen.includes(reason)) seen.push(reason);
    }
    return seen;
  }, [fields, blocked]);
  const idFor = (reason: string) => `${groupId}-${reasons.indexOf(reason)}`;

  return (
    <section className="field-group">
      <h4 className="field-group-title">{title}</h4>
      {reasons.map((reason) => (
        <p className="field-blocked" key={reason} id={idFor(reason)}>
          {reason}
        </p>
      ))}
      {fields.map((field) => {
        const reason = blocked.get(refOf(field));
        return (
          <FieldRow
            key={refOf(field)}
            field={field}
            kind={kind}
            wells={wells}
            onAdd={onAdd}
            blocked={Boolean(reason)}
            reasonId={reason ? idFor(reason) : undefined}
          />
        );
      })}
    </section>
  );
}

export default function FieldPanel({
  detail,
  wells,
  onAdd,
  blocked: supplied,
}: Props) {
  // Which fields the current selection has ruled out. Measures do the ruling
  // out; dimensions almost never do, because the server bridges them. See
  // joins.ts.
  const computed = useMemo(() => availability(detail, wells), [detail, wells]);
  const blocked = supplied ?? computed;
  return (
    <aside className="field-panel">
      {/* Keyboard instructions, which only a keyboard user needs. Always in
          the accessibility tree; shown on screen only once a field row has
          focus, which is exactly when the two keys mean anything. It used to
          sit above the list permanently, explaining a drag to the many people
          who were about to click. */}
      <p className="field-hint">
        Enter adds to the default well · Space picks up to drag
      </p>
      <FieldGroup
        title="Dimensions" kind="dimension" fields={detail.dimensions}
        wells={wells} onAdd={onAdd} blocked={blocked}
      />
      <FieldGroup
        title="Metrics" kind="metric" fields={detail.metrics}
        wells={wells} onAdd={onAdd} blocked={blocked}
      />
    </aside>
  );
}
