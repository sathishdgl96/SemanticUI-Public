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
  const cell = new Map<string, number | null>();

  for (const row of result.rows) {
    const category = String(row[a] ?? "");
    const legend = String(row[l] ?? "");
    if (!categories.includes(category)) categories.push(category);
    if (!legendValues.includes(legend)) legendValues.push(legend);
    const value = row[m];
    cell.set(
      `${category} ${legend}`,
      value === null || value === undefined ? null : Number(value),
    );
  }

  const series = legendValues.map((legend, i) => ({
    name: legend,
    colorIndex: i,
    data: categories.map((c) => cell.get(`${c} ${legend}`) ?? null),
  }));
  return { categories, series };
}
