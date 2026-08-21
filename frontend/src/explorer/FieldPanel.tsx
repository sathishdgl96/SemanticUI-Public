import { useDraggable } from "@dnd-kit/core";
import { useMemo } from "react";
import type { FieldInfo, SemanticViewDetail } from "../api/types";
import { availability } from "./joins";
import {
  compositeAvailability,
  type CompositeViewDetail,
} from "../models/availability";
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

function FieldRow({ field, kind, wells, onAdd, reason }: {
  field: FieldInfo;
  kind: FieldKind;
  wells: Wells;
  onAdd: Props["onAdd"];
  /** Why the current selection rules this field out, or undefined when it
   *  does not. Present means blocked; the text is what a hover shows. */
  reason?: string;
}) {
  const blocked = Boolean(reason);
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
  // dnd-kit puts its own `aria-describedby` in `attributes` (pointing at
  // the drag instructions), so the two have to be composed rather than
  // one spread over the other -- which silently dropped this hint when
  // `attributes` was spread last.
  const describedBy = attributes["aria-describedby"];
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      disabled={blocked}
      // The reason, where the field is. A disabled control gives no
      // other feedback, so without this a greyed row is a dead end with
      // no account of itself.
      title={reason}
      onClick={() => onAdd(defaultWellFor(kind, wells), ref, kind)}
      {...listeners}
      {...attributes}
      aria-describedby={describedBy || undefined}
      aria-label={reason ? `${refOf(field)} — ${reason}` : undefined}
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
  // The reason rides on the field it is about -- as its title, so a
  // pointer finds it, and as its accessible description, so a screen
  // reader does. It used to be a block of prose above the list, which
  // said the same three lines however many fields shared the reason and
  // pushed the ones still available off the top of the pane.
  return (
    <section className="field-group">
      <h4 className="field-group-title">{title}</h4>
      {fields.map((field) => (
        <FieldRow
          key={refOf(field)}
          field={field}
          kind={kind}
          wells={wells}
          onAdd={onAdd}
          reason={blocked.get(refOf(field))}
        />
      ))}
    </section>
  );
}

export default function FieldPanel({ detail, wells, onAdd }: Props) {
  // Which fields the current selection has ruled out. Measures do the ruling
  // out; dimensions almost never do, because the server bridges them. See
  // joins.ts.
  //
  // Which RULE applies is decided by the shape of the describe, not by a
  // flag the caller passes: a detail carrying `memberGraphs` came from a
  // model, whose reachability is per member. That used to hang on a
  // `compositeId` the caller had to remember -- and an explore saved
  // before that field existed reopened without it, so a model silently
  // fell back to the single-view rule, whose join graph a model's
  // describe deliberately leaves empty. Nothing was ever greyed.
  const blocked = useMemo(() => {
    const model = detail as CompositeViewDetail;
    return (model.memberGraphs?.length ?? 0) > 0
      ? compositeAvailability(model, wells)
      : availability(detail, wells);
  }, [detail, wells]);
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
