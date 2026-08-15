import { canDrop, type FieldKind, type WellId } from "./wells";

// Pure, unit-testable builders for dnd-kit's screen-reader announcements.
// dnd-kit's default announcer is purely geometric ("moved over droppable
// area X") and knows nothing about `canDrop` — it would happily announce
// a drop as if it succeeded even when our model silently rejected it (a
// metric dropped on Axis, say). These builders consult `canDrop` so the
// announcement always matches what actually happened.

const WELL_LABEL: Record<WellId, string> = {
  axis: "Axis",
  legend: "Legend",
  values: "Values",
};

const ACCEPTS_PLURAL: Record<WellId, string> = {
  axis: "dimensions",
  legend: "dimensions",
  values: "metrics",
};

function kindArticle(kind: FieldKind): string {
  return kind === "metric" ? "a metric" : "a dimension";
}

export function announceDragStart(ref: string): string {
  return `Picked up ${ref}.`;
}

export function announceDragOver(
  ref: string, kind: FieldKind, wellId: WellId | null,
): string {
  if (!wellId) return `${ref} is no longer over a well.`;
  const label = WELL_LABEL[wellId];
  if (canDrop(wellId, kind)) {
    return `${ref} over ${label}. ${label} accepts ${ACCEPTS_PLURAL[wellId]}.`;
  }
  return `${ref} over ${label}. ${label} accepts ${ACCEPTS_PLURAL[wellId]} only. This is ${kindArticle(kind)}.`;
}

export function announceDragEnd(
  ref: string, kind: FieldKind, wellId: WellId | null,
): string {
  if (!wellId) return `${ref} was not added. It was dropped outside any well.`;
  const label = WELL_LABEL[wellId];
  if (canDrop(wellId, kind)) {
    return `${ref} added to ${label}.`;
  }
  return `${ref} was not added. ${label} accepts ${ACCEPTS_PLURAL[wellId]} only.`;
}

export function announceDragCancel(): string {
  return "Drag cancelled. Nothing was added.";
}
