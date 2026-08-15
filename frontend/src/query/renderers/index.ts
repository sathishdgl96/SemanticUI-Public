import type { QueryResponse, Visual } from "../../api/types";
import type { VisualType } from "../../reports/catalog";
import { axisChrome, categoricalSeries, type EChartsOptionLike } from "./categorical";
import { pieOption } from "./pie";
import { scatterOption } from "./scatter";

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

/** The tile heading: an explicit title if set, else composed from the wells. */
export function visualTitle(visual: Visual): string {
  if (visual.title) return visual.title;
  const type = visual.type as VisualType;
  if (type === "kpi") return fieldName((visual.wells.value ?? [])[0] ?? "");
  if (type === "scatter") {
    const x = fieldName((visual.wells.x ?? [])[0] ?? "");
    const y = fieldName((visual.wells.y ?? [])[0] ?? "");
    return x && y ? `${y} against ${x}` : "";
  }
  if (type === "pie") {
    const value = fieldName((visual.wells.values ?? [])[0] ?? "");
    const legend = fieldName((visual.wells.legend ?? [])[0] ?? "");
    return value && legend ? `${value} by ${legend}` : value;
  }
  if (type === "table") return "Table";
  const values = (visual.wells.values ?? []).map(fieldName).join(", ");
  const axis = fieldName((visual.wells.axis ?? [])[0] ?? "");
  return axis ? `${values} by ${axis}` : values;
}

/** ECharts option for chart-shaped visuals; null for table and kpi, which are DOM. */
export function buildVisualOption(
  visual: Visual,
  result: QueryResponse,
): EChartsOptionLike | null {
  const type = visual.type as VisualType;
  if (type === "table" || type === "kpi") return null;
  if (type === "pie") return pieOption(visual, result);
  if (type === "scatter") return scatterOption(visual, result);

  const { categories, series } = categoricalSeries(visual, result);
  if (series.length === 0) return null;
  const stacked = type !== "line" && visual.options.stacked === true;

  // Bar/line/area series carry plain numeric `data` (not pie's {name,
  // itemStyle} slices) and bar has no lineStyle — see the type comment in
  // categorical.ts for why EChartsOptionLike still requires both.
  return {
    backgroundColor: "transparent",
    grid: axisChrome.grid(series.length > 1),
    tooltip: { trigger: "axis", axisPointer: { type: type === "bar" ? "shadow" : "line" } },
    legend: axisChrome.legend(series.length),
    xAxis: axisChrome.categoryAxis(categories),
    yAxis: axisChrome.valueAxis(),
    series: series.map((s) => {
      const color = axisChrome.color(s.colorIndex);
      if (type === "bar") {
        return {
          name: s.name, type: "bar", data: s.data, barGap: "10%",
          ...(stacked ? { stack: "total" } : {}),
          itemStyle: { color, borderRadius: [4, 4, 0, 0] },
        };
      }
      return {
        name: s.name, type: "line", data: s.data, showSymbol: false,
        ...(stacked ? { stack: "total" } : {}),
        ...(type === "area" ? { areaStyle: { color, opacity: 0.18 } } : {}),
        lineStyle: { width: 2 }, itemStyle: { color },
      };
    }),
  } as unknown as EChartsOptionLike;
}
