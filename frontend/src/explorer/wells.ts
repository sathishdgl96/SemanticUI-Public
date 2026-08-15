export type WellId = "axis" | "legend" | "values";
export type FieldKind = "dimension" | "metric";

export interface Wells {
  axis: string[];
  legend: string[];
  values: string[];
}

// Shape of the dnd-kit drag payload (`useDraggable`'s `data` prop). dnd-kit's
// hooks type `data.current` as `Record<string, any>` (it isn't generic over
// a data shape in this version), so consumers cast through this interface
// instead of touching `any` directly.
export interface DragData {
  ref: string;
  kind: FieldKind;
}

const CAPS: Record<WellId, number> = { axis: 1, legend: 1, values: Infinity };
const ACCEPTS: Record<WellId, FieldKind> = {
  axis: "dimension",
  legend: "dimension",
  values: "metric",
};

export function emptyWells(): Wells {
  return { axis: [], legend: [], values: [] };
}

export function canDrop(wellId: WellId, kind: FieldKind): boolean {
  return ACCEPTS[wellId] === kind;
}

export function addToWell(
  wells: Wells, wellId: WellId, ref: string, kind: FieldKind,
): Wells {
  if (!canDrop(wellId, kind)) return wells;
  const current = wells[wellId];
  if (current.includes(ref)) return wells;
  const next = CAPS[wellId] === 1 ? [ref] : [...current, ref];
  return { ...wells, [wellId]: next };
}

export function removeFromWell(wells: Wells, wellId: WellId, ref: string): Wells {
  return { ...wells, [wellId]: wells[wellId].filter((r) => r !== ref) };
}

export function reorderWell(
  wells: Wells, wellId: WellId, from: number, to: number,
): Wells {
  const next = [...wells[wellId]];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { ...wells, [wellId]: next };
}

export function defaultWellFor(kind: FieldKind, wells: Wells): WellId {
  if (kind === "metric") return "values";
  return wells.axis.length === 0 ? "axis" : "legend";
}

export function wellsToQuery(wells: Wells): {
  dimensions: string[];
  metrics: string[];
} {
  return {
    dimensions: [...wells.axis, ...wells.legend],
    metrics: [...wells.values],
  };
}
