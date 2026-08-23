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

// An explore is a QUERY, so it groups by as many dimensions as you like.
// The single-dimension cap that used to sit on `axis` was never a property
// of querying -- it came from the "Add to report" hand-off always building a
// BAR visual, whose axis takes one field. That hand-off now picks a visual
// type that fits what you selected (see visualForShape), so the cap has
// nothing left to protect and is gone.
//
// `legend` keeps its cap of one: it splits a measure into one series per
// value, and there is only one way to split a series.
const CAPS: Record<WellId, number> = { axis: Infinity, legend: 1, values: Infinity };
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
  // A ref may only ever occupy one well at a time. Without this, clicking
  // (or dropping) an already-placed field onto a different well — e.g. a
  // second click on a dimension that's already in Axis, which
  // `defaultWellFor` routes to Legend — would duplicate it across wells and
  // produce a query with the same column twice.
  if (Object.values(wells).some((refs) => refs.includes(ref))) return wells;
  const current = wells[wellId];
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

export function defaultWellFor(kind: FieldKind, _wells: Wells): WellId {
  if (kind === "metric") return "values";
  // Every dimension goes to the group-by well. It used to overflow into
  // `legend` once axis held one, which quietly meant a second dimension
  // changed the SHAPE of the chart rather than adding a grouping -- and a
  // third had nowhere to go at all. Splitting by a legend is now something
  // you ask for by dropping onto it.
  return "axis";
}

/** The visual type that fits what an explore selected.
 *
 *  A bar chart's axis takes exactly one dimension, so handing it two would
 *  produce a definition the server rejects. A table takes any number of
 *  both, which is the honest home for a multi-dimension grouping. */
export function visualForShape(wells: Wells): "bar" | "table" {
  const dimensions = wells.axis.length + wells.legend.length;
  return dimensions > 2 || wells.axis.length > 1 ? "table" : "bar";
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
