// Composition rules for filters, hierarchies and drill state. Deliberately
// React-free: what a visual's effective filter set IS can then be asserted
// directly, without rendering anything.

import type {
  BetweenFilter,
  CompareFilter,
  Filter,
  Hierarchy,
  IsFilter,
  Page,
  SheetRequest,
  TextFilter,
  Visual,
} from "../api/types";

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

/** Turn ticked slicer values into filters.
 *
 *  `exceptField` is the field of the slicer asking: a slicer must not filter
 *  itself, or ticking one value would hide every other option and leave no
 *  way back. Empty selections are skipped, so an untouched slicer constrains
 *  nothing -- the same rule `isActive` applies to half-built filters. */
export function slicerFiltersFrom(
  selections: Record<string, string[]>,
  exceptField = "",
): Filter[] {
  return Object.entries(selections)
    .filter(([field, values]) => field !== exceptField && values.length > 0)
    .map(([field, values]) => ({
      // Derived from the field, not random: this id lands in the query key,
      // and a fresh one each render would defeat caching entirely.
      id: `slicer:${field}`,
      field,
      op: "is" as const,
      values,
    }));
}

export function hierarchyIdOf(ref: string): string | null {
  return ref.startsWith(HIERARCHY_PREFIX)
    ? ref.slice(HIERARCHY_PREFIX.length)
    : null;
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

const ONE_VALUE_OPS: readonly string[] = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
];

/** Takes a list of picked values. */
export function takesValues(filter: Filter): filter is IsFilter {
  return filter.op === "is" || filter.op === "isNot";
}

/** Takes two endpoints. */
export function takesRange(filter: Filter): filter is BetweenFilter {
  return filter.op === "between" || filter.op === "notBetween";
}

/** Takes exactly one free-typed value. */
export function takesOneValue(filter: Filter): filter is TextFilter | CompareFilter {
  return ONE_VALUE_OPS.includes(filter.op);
}

/** Does this filter actually constrain anything yet?
 *
 *  A half-built filter — just added from the field picker, or whose operator
 *  was switched a moment ago — means "not filtering yet", not "match nothing".
 *  Sending one produced `IN ()`, which the API rejects with a 422 that fails
 *  every tile on the report. Mirrors `is_active` in
 *  backend/app/reports/filters.py. */
export function isActive(filter: Filter): boolean {
  // Written as guards rather than a chain of `op ===` checks. Narrowing by
  // ELIMINATION does not work on this union: several members have a union
  // for their own discriminant (BetweenFilter is "between" | "notBetween"),
  // and TypeScript will not rule such a member out in a negative branch. The
  // same trap is documented in describeFilter below.
  if (takesValues(filter)) return filter.values.length > 0;
  // Compared against "" rather than tested for truthiness: 0 is a real bound.
  if (takesRange(filter)) return filter.from !== "" && filter.to !== "";
  // Text and comparison alike: an empty box is "not filtering yet". An empty
  // LIKE pattern would match every row, which reads as no filter at all.
  if (takesOneValue(filter)) return filter.value !== "";
  // What is left -- a presence test, a relative window -- is complete the
  // moment it is chosen.
  return true;
}

/** The composed filter set for one visual: all-pages scope AND its page's AND
 *  its own AND the drill path AND any active cross-filter. Intersection, in
 *  that order. */
export function effectiveFilters({
  reportFilters,
  pageFilters = [],
  slicerFilters = [],
  visual,
  drill,
  crossFilter,
}: {
  reportFilters: Filter[];
  pageFilters?: Filter[];
  /** On-canvas slicer selections. Ephemeral, like drill and cross-filter. */
  slicerFilters?: Filter[];
  visual: Visual;
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}): Filter[] {
  const composed: Filter[] = [
    ...reportFilters,
    ...pageFilters,
    ...slicerFilters,
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

/** How each operator reads in a sentence. Shared by the summary below and by
 *  the editor's operator menu, so the two can never describe the same
 *  operator differently. */
export const OPERATOR_LABEL: Record<Filter["op"], string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to",
  isBlank: "is blank",
  isNotBlank: "is not blank",
  between: "is between",
  notBetween: "is not between",
  relativeDate: "is in the last",
};

/** A short human summary, for filter rows and chips. */
export function describeFilter(filter: Filter): string {
  // Each specific op is narrowed POSITIVELY, and the is/isNot pair is left
  // for last. Testing `op === "is" || op === "isNot"` first and falling
  // through does not narrow: IsFilter's own discriminant is a union, so
  // TypeScript cannot rule the member out in the negative branch, and the
  // later `filter.preset` reads fail to compile.
  if (takesRange(filter)) {
    const verb = filter.op === "between" ? "is between" : "is not between";
    return `${filter.field} ${verb} ${filter.from} and ${filter.to}`;
  }
  if (filter.op === "isBlank" || filter.op === "isNotBlank") {
    return `${filter.field} ${OPERATOR_LABEL[filter.op]}`;
  }
  if (takesOneValue(filter)) {
    return `${filter.field} ${OPERATOR_LABEL[filter.op]} ${filter.value}`;
  }
  if (filter.op === "relativeDate") {
    if (filter.preset === "monthToDate") return `${filter.field} month to date`;
    if (filter.preset === "yearToDate") return `${filter.field} year to date`;
    return `${filter.field} in the last ${filter.count} ${UNIT_LABEL[filter.unit ?? "day"]}`;
  }
  if (!takesValues(filter)) return filter.field;
  const verb = filter.op === "is" ? "is" : "is not";
  const what =
    filter.values.length === 1
      ? filter.values[0]
      : `${filter.values.length} values`;
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
  pages,
  reportFilters,
  slicerSelections = {},
  hierarchies,
  drill,
  crossFilter,
  titleOf,
  wellsToQuery,
}: {
  pages: Page[];
  reportFilters: Filter[];
  /** Ticked slicer values. Included so an export matches the screen. */
  slicerSelections?: Record<string, string[]>;
  hierarchies: Hierarchy[];
  drill: Record<string, DrillState>;
  crossFilter: CrossFilter | null;
  titleOf: (visual: Visual, wells: Record<string, string[]>) => string;
  wellsToQuery: (
    type: string,
    wells: Record<string, string[]>,
  ) => { dimensions: string[]; metrics: string[] };
}): SheetRequest[] {
  const multi = pages.length > 1;
  // Cross-filtering is page-local, as it is in PowerBI: a selection made on
  // one page must not silently constrain a sheet taken from another.
  const sourcePage = crossFilter
    ? pages.find((p) =>
        p.visuals.some((v) => v.id === crossFilter.sourceVisualId),
      )
    : undefined;

  const sliced = slicerFiltersFrom(slicerSelections);

  return pages.flatMap((page) => {
    const pageCross = page === sourcePage ? crossFilter : null;
    // Slicers only constrain the page they sit on, exactly as they do on
    // screen -- a sheet from another page must not inherit their ticks.
    const pageSlicers = page.visuals.some((v) => v.type === "slicer")
      ? sliced
      : [];
    return page.visuals
      .filter((visual) => visual.type !== "slicer")
      .map((visual) => {
        const own = drill[visual.id];
        const wells = resolveWells(visual.wells, hierarchies, own);
        const { dimensions, metrics } = wellsToQuery(visual.type, wells);

        const context: string[] = [];
        // Only worth saying when there is more than one page to be on.
        if (multi) context.push(`Page: ${page.name}`);
        if (own?.path.length) {
          context.push(
            `Drilled into ${own.path.map((s) => s.value).join(" > ")}`,
          );
        }
        if (pageCross && pageCross.sourceVisualId !== visual.id) {
          context.push(`Filtered by ${pageCross.field} = ${pageCross.value}`);
        }
        for (const f of pageSlicers) {
          context.push(
            `Sliced by ${f.field} = ${(f as IsFilter).values.join(", ")}`,
          );
        }

        const title = titleOf(visual, wells);
        return {
          title: multi ? `${page.name} — ${title}` : title,
          dimensions,
          metrics,
          filters: effectiveFilters({
            reportFilters,
            pageFilters: page.filters,
            slicerFilters: pageSlicers,
            visual,
            drill: own,
            crossFilter: pageCross,
          }),
          orderBy: [],
          context: context.join("; "),
        };
      });
  });
}
