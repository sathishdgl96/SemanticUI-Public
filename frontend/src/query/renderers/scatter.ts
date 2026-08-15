import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";
import type { EChartsOptionLike } from "./categorical";

export function scatterOption(visual: Visual, result: QueryResponse): EChartsOptionLike | null {
  const name = (ref: string) => ref.split(".", 2)[1] ?? ref;
  const idx = (n: string) =>
    result.columns.findIndex((c) => c.name.toUpperCase() === n.toUpperCase());
  const xRef = (visual.wells.x ?? [])[0];
  const yRef = (visual.wells.y ?? [])[0];
  const detailRef = (visual.wells.detail ?? [])[0];
  if (!xRef || !yRef) return null;
  const xi = idx(name(xRef));
  const yi = idx(name(yRef));
  if (xi < 0 || yi < 0) return null;
  const di = detailRef ? idx(name(detailRef)) : -1;

  const groups = new Map<string, [number, number][]>();
  for (const row of result.rows) {
    const key = di >= 0 ? String(row[di] ?? "") : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([Number(row[xi] ?? 0), Number(row[yi] ?? 0)]);
  }

  const series = [...groups.entries()].map(([key, points], i) => ({
    name: key || name(yRef),
    type: "scatter" as const,
    data: points,
    symbolSize: 9, // the >=8px marker floor
    itemStyle: {
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      borderColor: CHART_INK.surface,
      borderWidth: 1,
    },
  }));

  // Scatter's data points are [x, y] tuples, not the {name, itemStyle} shape
  // EChartsOptionLike's series[].data declares for pie's slices, and its
  // series items carry no lineStyle — see the type comment in categorical.ts
  // for why the shared type still requires both.
  return {
    backgroundColor: "transparent",
    grid: { left: 56, right: 16, top: 16, bottom: series.length > 1 ? 48 : 28 },
    tooltip: { trigger: "item" },
    legend: { show: series.length > 1, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    xAxis: {
      type: "value",
      name: name(xRef),
      nameTextStyle: { color: CHART_INK.muted },
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
    yAxis: {
      type: "value",
      name: name(yRef),
      nameTextStyle: { color: CHART_INK.muted },
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
    series,
  } as unknown as EChartsOptionLike;
}
