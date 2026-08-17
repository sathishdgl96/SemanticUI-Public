import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";
import { hexList } from "./categorical";
import type { PieOptionLike } from "./categorical";

export function pieOption(visual: Visual, result: QueryResponse): PieOptionLike | null {
  // The author's colours, if any; the shared palette otherwise. See
  // the note on axisChrome.color -- palette.ts is never edited.
  const custom = hexList(visual.options.colors);
  const legendRef = (visual.wells.legend ?? [])[0];
  const valueRef = (visual.wells.values ?? [])[0];
  const name = (ref: string) => ref.split(".", 2)[1] ?? ref;
  const idx = (n: string) =>
    result.columns.findIndex((c) => c.name.toUpperCase() === n.toUpperCase());
  const li = legendRef ? idx(name(legendRef)) : -1;
  const vi = valueRef ? idx(name(valueRef)) : -1;
  if (li < 0 || vi < 0) return null;

  const data = result.rows.map((row, i) => ({
    name: String(row[li] ?? ""),
    value: Number(row[vi] ?? 0),
    itemStyle: {
      color: custom[i] ?? SERIES_COLORS[i % SERIES_COLORS.length],
      borderColor: CHART_INK.surface,
      borderWidth: 2, // the 2px surface gap between adjacent fills
    },
  }));

  // No xAxis/yAxis here — deliberately: a pie chart never renders cartesian
  // axes, and PieOptionLike doesn't claim otherwise (see categorical.ts).
  // This return needs no cast: it's already structurally a PieOptionLike.
  return {
    backgroundColor: "transparent",
    // Confined to the chart's own box: a tile clips its overflow, so a
    // tooltip near an edge would otherwise be drawn half outside and read as
    // truncated data ("ustomer#0001" instead of "Customer#0001").
    tooltip: { trigger: "item", confine: true },
    legend: { show: true, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    series: [{
      type: "pie",
      radius: visual.options.donut ? ["45%", "70%"] : ["0%", "70%"],
      center: ["50%", "45%"],
      data,
      label: { color: CHART_INK.secondary },
    }],
  };
}
