/** The explorer's visualisation gallery.
 *
 *  An explore has three wells (group by, split by, measures) and the report
 *  catalog has sixteen visual types, each with wells of its own. This is the
 *  translation between them, so the explorer can offer the whole gallery
 *  instead of the one bar chart it used to auto-pick -- and so "Add to
 *  report" hands over exactly what is on screen rather than something else.
 *
 *  Nothing here decides whether a combination is legal: `validateWells` in
 *  the catalog already does, and it is the same rule the server enforces.
 *  This only decides which explorer field goes in which well.
 */

import type { Visual } from "../api/types";
import { CATALOG, emptyWellsFor, validateWells, type VisualType } from "../reports/catalog";
import type { Wells } from "./wells";

/** Everything except `slicer`, which is a filter control rather than a way
 *  of showing an answer -- it has no result set to draw. */
export const EXPLORE_VISUALS: VisualType[] = (
  Object.keys(CATALOG) as VisualType[]
).filter((type) => type !== "slicer");

export function wellsForType(
  type: VisualType,
  wells: Wells,
): Record<string, string[]> {
  const dimensions = [...wells.axis, ...wells.legend];
  const mapped = { ...emptyWellsFor(type) };
  switch (type) {
    case "bar":
    case "hbar":
    case "line":
    case "area":
      mapped.axis = wells.axis.slice(0, 1);
      // A second Group-by dimension becomes the series split. Dropping it
      // instead left the query still grouping by it, so the chart drew the
      // same category label several times over with one series -- the
      // second dimension invisible but silently reshaping the data. As the
      // split it draws the way people expect two dimensions to draw:
      // side by side within each category, one colour per value.
      mapped.legend = wells.legend.length
        ? wells.legend.slice(0, 1)
        : wells.axis.slice(1, 2);
      mapped.values = wells.values;
      break;
    case "combo":
      mapped.axis = wells.axis.slice(0, 1);
      mapped.values = wells.values;
      mapped.lineValues = [];
      break;
    case "pie":
    case "donut":
    case "treemap":
    case "funnel":
      // One category against one measure. The first dimension is the
      // category whichever well it was dropped into.
      mapped.legend = dimensions.slice(0, 1);
      mapped.values = wells.values.slice(0, 1);
      break;
    case "gauge":
      mapped.value = wells.values.slice(0, 1);
      mapped.target = wells.values.slice(1, 2);
      break;
    case "scatter":
      // Two measures make the axes; a dimension, if there is one, separates
      // the points rather than positioning them.
      mapped.x = wells.values.slice(0, 1);
      mapped.y = wells.values.slice(1, 2);
      mapped.detail = dimensions.slice(0, 1);
      break;
    case "matrix":
      mapped.rows = wells.axis;
      mapped.columns = wells.legend.slice(0, 1);
      mapped.values = wells.values;
      break;
    case "kpi":
      mapped.value = wells.values.slice(0, 1);
      break;
    case "table":
    case "multiCard":
      mapped.dimensions = dimensions;
      mapped.metrics = wells.values;
      break;
    default:
      break;
  }
  return mapped;
}

/** Whether this selection can be drawn as this type at all. */
export function canRender(type: VisualType, wells: Wells): boolean {
  return validateWells(type, wellsForType(type, wells)).length === 0;
}

/** Selected fields this type has no room for.
 *
 *  A pie shows one measure. Given two, the mapping above takes the first and
 *  the chart is perfectly valid -- and quietly answers a different question
 *  than the one on screen. The picker says which fields went unused rather
 *  than letting the chart imply it is showing everything.
 */
export function unusedFields(type: VisualType, wells: Wells): string[] {
  const mapped = wellsForType(type, wells);
  const drawn = new Set(Object.values(mapped).flat());
  return [...wells.axis, ...wells.legend, ...wells.values].filter(
    (ref) => !drawn.has(ref),
  );
}

/** The type to draw when the user has not picked one.
 *
 *  A bar up to TWO dimensions -- one on the axis, one as the colour split --
 *  and a table beyond that, where a bar has nowhere left to put them. It
 *  used to fall back to a table at two, because a bar's axis takes exactly
 *  one; that stopped being the whole story once the second dimension became
 *  the series split (see wellsForType).
 */
export function defaultTypeFor(wells: Wells): VisualType {
  const dimensions = wells.axis.length + wells.legend.length;
  // Nothing to measure: show the rows rather than an empty chart.
  if (wells.values.length === 0) return "table";
  // Nothing to group by: a bar would have no axis, so a single measure is a
  // card and several are a table. This is the case that used to leave "Add
  // to report" disabled -- a lone measure is a perfectly good report.
  if (dimensions === 0) return wells.values.length === 1 ? "kpi" : "table";
  return dimensions > 2 ? "table" : "bar";
}

/** The type actually drawn: what the user picked, if it still works.
 *
 *  A selection can grow past what a pie can show. Silently drawing something
 *  else would be worse than falling back visibly, so the picker keeps the
 *  chosen button pressed only while `canRender` holds.
 */
export function effectiveType(chosen: VisualType | null, wells: Wells): VisualType {
  if (chosen && canRender(chosen, wells)) return chosen;
  return defaultTypeFor(wells);
}

/** The explore, expressed as a report visual: what gets drawn, and what
 *  "Add to report" hands over. */
export function exploreVisual(type: VisualType, wells: Wells): Visual {
  return {
    id: "explore",
    type,
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: wellsForType(type, wells),
    options: {},
    filters: [],
  };
}
