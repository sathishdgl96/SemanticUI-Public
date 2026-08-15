import type { QueryResponse } from "../api/types";
import type { ChartSeries } from "./buildChartOption";

export function pivotLegend(
  result: QueryResponse,
  axisName: string,
  legendName: string,
  metricName: string,
): { categories: string[]; series: ChartSeries[] } {
  const idx = (name: string) =>
    result.columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
  const a = idx(axisName), l = idx(legendName), m = idx(metricName);
  if (a < 0 || l < 0 || m < 0) return { categories: [], series: [] };

  const categories: string[] = [];
  const legendValues: string[] = [];
  // Keyed category -> legend -> value, rather than a single string-joined
  // key. A joined key like `${category} ${legend}` can collide for two
  // distinct pairs (e.g. "East Coast"+"Sales" and "East"+"Coast Sales" both
  // stringify to "East Coast Sales"), silently overwriting one series'
  // value with another's. Nesting removes that possibility structurally.
  const cells = new Map<string, Map<string, number | null>>();

  for (const row of result.rows) {
    const category = String(row[a] ?? "");
    const legend = String(row[l] ?? "");
    if (!categories.includes(category)) categories.push(category);
    if (!legendValues.includes(legend)) legendValues.push(legend);
    const value = row[m];
    const resolved = value === null || value === undefined ? null : Number(value);
    let byLegend = cells.get(category);
    if (!byLegend) {
      byLegend = new Map();
      cells.set(category, byLegend);
    }
    byLegend.set(legend, resolved);
  }

  const series = legendValues.map((legend, i) => ({
    name: legend,
    colorIndex: i,
    data: categories.map((c) => cells.get(c)?.get(legend) ?? null),
  }));
  return { categories, series };
}
