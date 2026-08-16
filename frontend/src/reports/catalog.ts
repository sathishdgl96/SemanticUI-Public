// Mirrors backend/app/reports/catalog.py. Both files are covered by tests
// asserting the same rules, so they cannot drift apart silently.

export type VisualType =
  | "bar"
  | "hbar"
  | "line"
  | "area"
  | "combo"
  | "pie"
  | "donut"
  | "treemap"
  | "funnel"
  | "gauge"
  | "scatter"
  | "table"
  | "matrix"
  | "kpi"
  | "multiCard"
  | "slicer";
export type FieldKind = "dimension" | "metric";

// Mirrors MAX_PAGES / MAX_VISUALS in backend/app/reports/schema.py. Enforced
// there; carried here so the builder can refuse before a save round-trips.
export const MAX_PAGES = 20;
export const MAX_VISUALS = 50;

export interface WellSpec {
  key: string;
  label: string;
  kind: FieldKind;
  min: number;
  max: number | null; // null = unbounded
}

export interface VisualSpec {
  type: VisualType;
  label: string;
  glyph: string;
  wells: WellSpec[];
  /** Option keys this type declares. `optionsFor` adds the shared ones. */
  options: string[];
}

/** Options every visual type understands, whatever else it declares.
 *
 *  "aggregations" maps a FACT reference to the function applied to it
 *  ({"ORDERS.QUANTITY": "sum"}). It belongs to every type because any type
 *  with a measure well can hold a fact. Mirrors COMMON_OPTIONS in
 *  backend/app/reports/catalog.py. */
export const COMMON_OPTIONS = ["aggregations"];

/** Every option key this type accepts, its own plus the shared ones. */
export function optionsFor(type: VisualType): string[] {
  return [...CATALOG[type].options, ...COMMON_OPTIONS];
}

/** The aggregation functions offered for a raw fact, in the order PowerBI
 *  lists them. Mirrors AGGREGATE_SQL in backend/app/semantic/query.py. */
export const AGGREGATIONS = [
  { fn: "sum", label: "Sum" },
  { fn: "avg", label: "Average" },
  { fn: "min", label: "Minimum" },
  { fn: "max", label: "Maximum" },
  { fn: "count", label: "Count" },
  { fn: "countDistinct", label: "Count (distinct)" },
] as const;

export type AggregationFn = (typeof AGGREGATIONS)[number]["fn"];

/** What an unaggregated fact defaults to when first placed. */
export const DEFAULT_AGGREGATION: AggregationFn = "sum";

const CATEGORICAL: WellSpec[] = [
  { key: "axis", label: "Axis", kind: "dimension", min: 1, max: 1 },
  { key: "legend", label: "Legend", kind: "dimension", min: 0, max: 1 },
  { key: "values", label: "Values", kind: "metric", min: 1, max: null },
];

/** One categorical dimension against one measure — pie, donut, treemap, funnel. */
const ONE_BY_ONE: WellSpec[] = [
  { key: "legend", label: "Legend", kind: "dimension", min: 1, max: 1 },
  { key: "values", label: "Values", kind: "metric", min: 1, max: 1 },
];

const STACKING = ["stacked", "stacked100"];

export const CATALOG: Record<VisualType, VisualSpec> = {
  bar: { type: "bar", label: "Column", glyph: "▥", wells: CATEGORICAL, options: STACKING },
  hbar: { type: "hbar", label: "Bar", glyph: "▤", wells: CATEGORICAL, options: STACKING },
  line: { type: "line", label: "Line", glyph: "📈", wells: CATEGORICAL, options: [] },
  area: { type: "area", label: "Area", glyph: "▨", wells: CATEGORICAL, options: STACKING },
  combo: {
    type: "combo", label: "Line and column", glyph: "⎍",
    wells: [
      { key: "axis", label: "Axis", kind: "dimension", min: 1, max: 1 },
      { key: "values", label: "Column values", kind: "metric", min: 1, max: null },
      { key: "lineValues", label: "Line values", kind: "metric", min: 0, max: null },
    ],
    options: [],
  },
  pie: { type: "pie", label: "Pie", glyph: "◕", wells: ONE_BY_ONE, options: ["donut"] },
  donut: { type: "donut", label: "Donut", glyph: "◍", wells: ONE_BY_ONE, options: [] },
  treemap: { type: "treemap", label: "Treemap", glyph: "▦", wells: ONE_BY_ONE, options: [] },
  funnel: { type: "funnel", label: "Funnel", glyph: "⧨", wells: ONE_BY_ONE, options: [] },
  gauge: {
    type: "gauge", label: "Gauge", glyph: "◑",
    wells: [
      { key: "value", label: "Value", kind: "metric", min: 1, max: 1 },
      { key: "target", label: "Target", kind: "metric", min: 0, max: 1 },
    ],
    options: [],
  },
  scatter: {
    type: "scatter", label: "Scatter", glyph: "⁘",
    wells: [
      { key: "x", label: "X axis", kind: "metric", min: 1, max: 1 },
      { key: "y", label: "Y axis", kind: "metric", min: 1, max: 1 },
      { key: "detail", label: "Detail", kind: "dimension", min: 0, max: 1 },
    ],
    options: [],
  },
  table: {
    type: "table", label: "Table", glyph: "▤",
    wells: [
      { key: "dimensions", label: "Dimensions", kind: "dimension", min: 0, max: null },
      { key: "metrics", label: "Metrics", kind: "metric", min: 0, max: null },
    ],
    options: [],
  },
  matrix: {
    type: "matrix", label: "Matrix", glyph: "⊞",
    wells: [
      { key: "rows", label: "Rows", kind: "dimension", min: 1, max: null },
      { key: "columns", label: "Columns", kind: "dimension", min: 0, max: 1 },
      { key: "values", label: "Values", kind: "metric", min: 1, max: null },
    ],
    options: ["subtotals"],
  },
  kpi: {
    type: "kpi", label: "Card", glyph: "Σ",
    wells: [{ key: "value", label: "Value", kind: "metric", min: 1, max: 1 }],
    options: ["format"],
  },
  multiCard: {
    type: "multiCard", label: "Multi-row card", glyph: "▤",
    wells: [
      { key: "dimensions", label: "Fields", kind: "dimension", min: 0, max: null },
      { key: "metrics", label: "Values", kind: "metric", min: 1, max: null },
    ],
    options: ["format"],
  },
  slicer: {
    type: "slicer", label: "Slicer", glyph: "⛃",
    wells: [{ key: "field", label: "Field", kind: "dimension", min: 1, max: 1 }],
    options: ["multiSelect"],
  },
};

export function emptyWellsFor(type: VisualType): Record<string, string[]> {
  return Object.fromEntries(CATALOG[type].wells.map((w) => [w.key, []]));
}

export function wellsToQuery(
  type: VisualType,
  wells: Record<string, string[]>,
): { dimensions: string[]; metrics: string[] } {
  const dimensions: string[] = [];
  const metrics: string[] = [];
  for (const well of CATALOG[type].wells) {
    const target = well.kind === "dimension" ? dimensions : metrics;
    target.push(...(wells[well.key] ?? []));
  }
  return { dimensions, metrics };
}

export function validateWells(
  type: VisualType,
  wells: Record<string, string[]>,
): string[] {
  const spec = CATALOG[type];
  const problems: string[] = [];
  const known = new Set(spec.wells.map((w) => w.key));
  for (const key of Object.keys(wells)) {
    if (!known.has(key)) problems.push(`${spec.label} has no well named "${key}"`);
  }
  const seen = new Map<string, string>();
  for (const well of spec.wells) {
    const refs = wells[well.key] ?? [];
    if (refs.length < well.min) {
      problems.push(`${well.label} needs at least ${well.min} field(s)`);
    }
    if (well.max !== null && refs.length > well.max) {
      problems.push(`${well.label} takes at most ${well.max} field(s)`);
    }
    for (const ref of refs) {
      const existing = seen.get(ref);
      if (existing) {
        problems.push(`${ref} appears in more than one well (${existing} and ${well.label})`);
      } else {
        seen.set(ref, well.label);
      }
    }
  }
  if (type === "table" && seen.size === 0) {
    problems.push("Table needs at least one field");
  }
  return problems;
}

/** Which well a clicked field belongs in, or null when every eligible well is full. */
export function defaultWellFor(
  type: VisualType,
  kind: FieldKind,
  wells: Record<string, string[]>,
): string | null {
  for (const well of CATALOG[type].wells) {
    if (well.kind !== kind) continue;
    const count = (wells[well.key] ?? []).length;
    if (well.max === null || count < well.max) return well.key;
  }
  return null;
}
