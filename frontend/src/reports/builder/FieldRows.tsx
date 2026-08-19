import { useDraggable } from "@dnd-kit/core";
import type { FieldInfo, Hierarchy } from "../../api/types";
import type { FieldKind } from "../catalog";
import { HIERARCHY_PREFIX } from "../filters";

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

export function BuilderFieldRow({
  field,
  kind,
  onAdd,
}: {
  field: FieldInfo;
  kind: FieldKind;
  onAdd: (ref: string, kind: FieldKind) => void;
}) {
  const ref = refOf(field);
  const { attributes, listeners, setNodeRef } = useDraggable({ id: ref, data: { ref, kind } });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      onClick={() => onAdd(ref, kind)}
      {...listeners}
      {...attributes}
    >
      <span className="field-glyph">{kind === "metric" ? "Σ" : "⬦"}</span>
      {/* Just the field name: the Data pane already groups by table, so the
          prefix is redundant and it truncated every row. The full ref stays
          available as the tooltip and in the checkbox's accessible name. */}
      <span className="field-ref" title={ref}>
        {field.name}
      </span>
      {field.dataType && <small>{field.dataType}</small>}
    </button>
  );
}

/** Hierarchies are placed exactly like dimensions -- click or drag -- but
 *  carry a "hierarchy:<id>" reference instead of a field name. Without this
 *  row there is no way to put one on an axis at all. */
export function BuilderHierarchyRow({
  hierarchy,
  onAdd,
}: {
  hierarchy: Hierarchy;
  onAdd: (ref: string, kind: FieldKind) => void;
}) {
  const ref = `${HIERARCHY_PREFIX}${hierarchy.id}`;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: ref,
    data: { ref, kind: "dimension" as FieldKind },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      // Explicit, so the decorative glyph stays out of the accessible name
      // and the level count is announced as a phrase rather than a fragment.
      aria-label={`${hierarchy.name} hierarchy, ${hierarchy.levels.length} levels`}
      onClick={() => onAdd(ref, "dimension")}
      {...listeners}
      {...attributes}
    >
      <span className="field-glyph">⛭</span>
      <span className="field-ref">{hierarchy.name}</span>
      <small>{hierarchy.levels.length} levels</small>
    </button>
  );
}
