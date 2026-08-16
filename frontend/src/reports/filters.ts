// Composition rules for filters, hierarchies and drill state. Deliberately
// React-free: what a visual's effective filter set IS can then be asserted
// directly, without rendering anything.

import type { Filter, Hierarchy, SheetRequest, Visual } from "../api/types";

/** A well entry of this shape stands in for a whole drill path, not a field.
 *  Mirrors HIERARCHY_PREFIX in backend/app/reports/catalog.py. */
export const HIERARCHY_PREFIX = "hierarchy:";

export interface DrillStep {
  field: string;
  value: string;
}

/** Where one visual currently sits in a hierarchy. Ephemeral by design — held
 *  in component state, never written to the definition — so a saved report
 *  always opens at the top level and can never point at a value that has
 *  since disappeared from the view. */
export interface DrillState {
  hierarchyId: string;
  path: DrillStep[];
}

/** A selection made by clicking a mark. Also ephemeral. */
export interface CrossFilter {
  sourceVisualId: string;
  field: string;
  value: string;
}

export function hierarchyIdOf(ref: string): string | null {
  return ref.startsWith(HIERARCHY_PREFIX) ? ref.slice(HIERARCHY_PREFIX.length) : null;
}

export function hierarchyById(
  hierarchies: Hierarchy[],
  id: string,
): Hierarchy | undefined {
  return hierarchies.find((h) => h.id === id);
}

export function currentLevel(hierarchy: Hierarchy, depth: number): string {
  // Clamped: a drill path can only ever be as deep as the hierarchy is long,
  // but clamping here means a stale path renders the deepest level rather
  // than `undefined`.
  const index = Math.min(depth, hierarchy.levels.length - 1);
  return hierarchy.levels[index];
}

export function canDrillDown(hierarchy: Hierarchy, depth: number): boolean {
  return depth < hierarchy.levels.length - 1;
}

/** Replace hierarchy references with the single field the visual should select
 *  right now. This is what the query API receives — it never sees a hierarchy. */
export function resolveWells(
  wells: Record<string, string[]>,
  hierarchies: Hierarchy[],
  drill: DrillState | undefined,
): Record<string, string[]> {
  const resolved: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(wells)) {
    resolved[key] = refs.flatMap((ref) => {
      const id = hierarchyIdOf(ref);
      if (id === null) return [ref];
      const hierarchy = hierarchyById(hierarchies, id);
      // A reference to a hierarchy that no longer exists yields nothing; the
      // visual then fails its own well validation and says so, which beats
      // sending "hierarchy:gone" to the server as a field name.
      if (!hierarchy) return [];
      const depth = drill?.hierarchyId === id ? drill.path.length : 0;
      return [currentLevel(hierarchy, depth)];
    });
  }
  return resolved;
}

/** One equality filter per level already drilled through. */
export function drillFilters(drill: DrillState | undefined): Filter[] {
  if (!drill) return [];
  return drill.path.map((step) => ({
    // Derived from the field rather than randomly generated: these end up in
    // the TanStack Query key, and a fresh id each render would make every key
    // unique and defeat caching entirely.
    id: `drill:${step.field}`,
    field: step.field,
    op: "is" as const,
    values: [step.value],
  }));
}

/** Does this filter actually constrain anything yet?
 *
 *  A half-built filter — just added from the field picker, or whose operator
 *  was switched a moment ago — means "not filtering yet", not "match nothing".
 *  Sending one produced `IN ()`, which the API rejects with a 422 that fails
 *  every tile on the report. Mirrors `is_active` in
 *  backend/app/reports/filters.py. */
export function isActive(filter: Filter): boolean {
  if (filter.op === "is" || filter.op === "isNot") return filter.values.length > 0;
  // Compared against "" rather than tested for truthiness: 0 is a real bound.
  if (filter.op === "between") return filter.from !== "" && filter.to !== "";
  return true;
}

/** The composed filter set for one visual: report scope AND its own AND the
 *  drill path AND any active cross-filter. Intersection, in that order. */
export function effectiveFilters({
  reportFilters,
  visual,
  drill,
  crossFilter,
}: {
  reportFilters: Filter[];
  visual: Visual;
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}): Filter[] {
  const composed: Filter[] = [
    ...reportFilters,
    ...(visual.filters ?? []),
    ...drillFilters(drill),
    // Filtered at the end so an unfinished filter never reaches the API, and
    // — just as importantly — never churns the query key while the user is
    // still ticking boxes.
  ].filter(isActive);
  // A visual filtering itself by its own selection would collapse to the one
  // clicked mark the moment you clicked it.
  if (crossFilter && crossFilter.sourceVisualId !== visual.id) {
    composed.push({
      id: `xf:${crossFilter.field}`,
      field: crossFilter.field,
      op: "is",
      values: [crossFilter.value],
    });
  }
  return composed;
}

const UNIT_LABEL: Record<string, string> = {
  day: "days",
  month: "months",
  year: "years",
};

/** A short human summary, for filter rows and chips. */
export function describeFilter(filter: Filter): string {
  // Each specific op is narrowed POSITIVELY, and the is/isNot pair is left
  // for last. Testing `op === "is" || op === "isNot"` first and falling
  // through does not narrow: IsFilter's own discriminant is a union, so
  // TypeScript cannot rule the member out in the negative branch, and the
  // later `filter.preset` reads fail to compile.
  if (filter.op === "between") {
    return `${filter.field} is between ${filter.from} and ${filter.to}`;
  }
  if (filter.op === "relativeDate") {
    if (filter.preset === "monthToDate") return `${filter.field} month to date`;
    if (filter.preset === "yearToDate") return `${filter.field} year to date`;
    return `${filter.field} in the last ${filter.count} ${UNIT_LABEL[filter.unit ?? "day"]}`;
  }
  const verb = filter.op === "is" ? "is" : "is not";
  const what =
    filter.values.length === 1 ? filter.values[0] : `${filter.values.length} values`;
  return `${filter.field} ${verb} ${what}`;
}

/** Ids only need to be unique within one report, and `crypto.randomUUID` is
 *  already how visual ids are minted in BuilderPage. */
export function newFilterId(): string {
  return `f${crypto.randomUUID().slice(0, 8)}`;
}

/** One export sheet per visual, carrying exactly what that tile is currently
 *  showing -- drill position and cross-filter included.
 *
 *  Built from the same `resolveWells` and `effectiveFilters` that produce the
 *  tile's own query, so an export can never quietly disagree with the screen
 *  it was taken from. */
export function sheetRequestsFor({
  visuals,
  reportFilters,
  hierarchies,
  drill,
  crossFilter,
  titleOf,
  wellsToQuery,
}: {
  visuals: Visual[];
  reportFilters: Filter[];
  hierarchies: Hierarchy[];
  drill: Record<string, DrillState>;
  crossFilter: CrossFilter | null;
  titleOf: (visual: Visual, wells: Record<string, string[]>) => string;
  wellsToQuery: (
    type: string,
    wells: Record<string, string[]>,
  ) => { dimensions: string[]; metrics: string[] };
}): SheetRequest[] {
  return visuals.map((visual) => {
    const own = drill[visual.id];
    const wells = resolveWells(visual.wells, hierarchies, own);
    const { dimensions, metrics } = wellsToQuery(visual.type, wells);

    const context: string[] = [];
    if (own?.path.length) {
      context.push(`Drilled into ${own.path.map((s) => s.value).join(" > ")}`);
    }
    if (crossFilter && crossFilter.sourceVisualId !== visual.id) {
      context.push(`Filtered by ${crossFilter.field} = ${crossFilter.value}`);
    }

    return {
      title: titleOf(visual, wells),
      dimensions,
      metrics,
      filters: effectiveFilters({ reportFilters, visual, drill: own, crossFilter }),
      orderBy: [],
      context: context.join("; "),
    };
  });
}
