// Mirrors backend/app/reports/catalog.py. Both files are covered by tests
// asserting the same rules, so they cannot drift apart silently.

export type VisualType = "bar" | "line" | "area" | "pie" | "scatter" | "table" | "kpi";
export type FieldKind = "dimension" | "metric";

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
  options: string[];
}

const CATEGORICAL: WellSpec[] = [
  { key: "axis", label: "Axis", kind: "dimension", min: 1, max: 1 },
  { key: "legend", label: "Legend", kind: "dimension", min: 0, max: 1 },
  { key: "values", label: "Values", kind: "metric", min: 1, max: null },
];

export const CATALOG: Record<VisualType, VisualSpec> = {
  bar: { type: "bar", label: "Bar", glyph: "▦", wells: CATEGORICAL, options: ["stacked"] },
  line: { type: "line", label: "Line", glyph: "📈", wells: CATEGORICAL, options: [] },
  area: { type: "area", label: "Area", glyph: "▨", wells: CATEGORICAL, options: ["stacked"] },
  pie: {
    type: "pie", label: "Pie", glyph: "◕",
    wells: [
      { key: "legend", label: "Legend", kind: "dimension", min: 1, max: 1 },
      { key: "values", label: "Values", kind: "metric", min: 1, max: 1 },
    ],
    options: ["donut"],
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
  kpi: {
    type: "kpi", label: "KPI card", glyph: "Σ",
    wells: [{ key: "value", label: "Value", kind: "metric", min: 1, max: 1 }],
    options: ["format"],
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
