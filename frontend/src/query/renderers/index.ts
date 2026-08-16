import type { QueryResponse, Visual } from "../../api/types";
import type { VisualType } from "../../reports/catalog";
import {
  axisChrome,
  categoricalSeries,
  formatNumber,
  formatOptionsOf,
  type CategoricalOptionLike,
  type EChartsOptionLike,
  type Series,
} from "./categorical";
import { CHART_INK } from "../palette";
import { pieOption } from "./pie";
import { funnelOption, gaugeOption, treemapOption } from "./proportional";
import { scatterOption } from "./scatter";

/** Types whose ECharts option is built by the categorical (cartesian) path. */
const CARTESIAN = new Set<VisualType>(["bar", "hbar", "line", "area", "combo"]);

/** Types drawn from the DOM rather than ECharts. */
const DOM_RENDERED = new Set<VisualType>([
  "table",
  "matrix",
  "kpi",
  "multiCard",
  "slicer",
]);

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

/** The tile heading: an explicit title if set, else composed from the wells. */
export function visualTitle(visual: Visual): string {
  if (visual.title) return visual.title;
  const type = visual.type as VisualType;
  if (type === "kpi" || type === "gauge") {
    return fieldName((visual.wells.value ?? [])[0] ?? "");
  }
  if (type === "slicer") return fieldName((visual.wells.field ?? [])[0] ?? "");
  if (type === "scatter") {
    const x = fieldName((visual.wells.x ?? [])[0] ?? "");
    const y = fieldName((visual.wells.y ?? [])[0] ?? "");
    return x && y ? `${y} against ${x}` : "";
  }
  if (type === "pie" || type === "donut" || type === "treemap" || type === "funnel") {
    const value = fieldName((visual.wells.values ?? [])[0] ?? "");
    const legend = fieldName((visual.wells.legend ?? [])[0] ?? "");
    return value && legend ? `${value} by ${legend}` : value;
  }
  if (type === "table") return "Table";
  if (type === "multiCard") {
    return (visual.wells.metrics ?? []).map(fieldName).join(", ");
  }
  if (type === "matrix") {
    const values = (visual.wells.values ?? []).map(fieldName).join(", ");
    const rows = fieldName((visual.wells.rows ?? [])[0] ?? "");
    return rows ? `${values} by ${rows}` : values;
  }
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
  if (DOM_RENDERED.has(type)) return null;
  // Donut is a pie with a hole; keeping it a distinct type is a gallery
  // decision, not a rendering one.
  if (type === "pie") return pieOption(visual, result);
  if (type === "donut") {
    return pieOption({ ...visual, options: { ...visual.options, donut: true } }, result);
  }
  if (type === "treemap") return treemapOption(visual, result);
  if (type === "funnel") return funnelOption(visual, result);
  if (type === "gauge") return gaugeOption(visual, result);
  if (type === "scatter") return scatterOption(visual, result);
  if (!CARTESIAN.has(type)) return null;

  const { categories, series } = categoricalSeries(visual, result);
  if (series.length === 0) return null;
  const stackable = type !== "line" && type !== "combo";
  const stacked100 = stackable && visual.options.stacked100 === true;
  const stacked = stacked100 || (stackable && visual.options.stacked === true);
  const horizontal = type === "hbar";
  // How many leading series come from the Column values well; the rest were
  // read from Line values and are drawn as lines. Only `combo` splits them.
  const columnCount =
    type === "combo" ? (visual.wells.values ?? []).length : series.length;

  // The one remaining cast in this module (per the type comment in
  // categorical.ts): CategoricalSeriesItemLike requires lineStyle so line's
  // `.lineStyle.width` type-checks, but bar's branch of the ternary below
  // never sets it — bar series simply ignore an unused lineStyle key, unlike
  // pie's xAxis/yAxis, which ECharts renders as visible empty components if
  // present at all. That asymmetry is why pie/scatter need no cast but this
  // categorical branch still does.
  // 100% stacking is a rescale of the data, not an ECharts flag: each point
  // becomes its share of that category's total. Done here so the axis, the
  // tooltip and the exported numbers all agree on what is being drawn.
  const drawn = stacked100 ? toPercentages(series) : series;

  const format = formatOptionsOf(visual.options);
  const legend = axisChrome.legend(drawn.length, format);
  const categoryAxis = axisChrome.categoryAxis(categories, format);
  const baseValueAxis = axisChrome.valueAxis(format.showGridlines, format);
  const valueAxis = stacked100
    ? { ...baseValueAxis, max: 100, axisLabel: { ...baseValueAxis.axisLabel, formatter: "{value}%" } }
    : baseValueAxis;

  return {
    backgroundColor: "transparent",
    title: axisChrome.legendTitle(format, legend.show),
    grid: axisChrome.grid(legend.show, format),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: type === "line" ? "line" : "shadow" },
      // Confined to the chart's own box: a tile clips its overflow, so a
      // tooltip near an edge would otherwise be drawn half outside and read
      // as truncated data ("ustomer#0001" instead of "Customer#0001").
      confine: true,
    },
    legend,
    // A horizontal bar is the same chart with its axes exchanged: the
    // categories run down the y axis and the measure along the x.
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: drawn.map((s, i) => {
      const color = axisChrome.color(s.colorIndex);
      const asColumn = type === "bar" || type === "hbar" || (type === "combo" && i < columnCount);
      // Labels sit outside a column and above a line, which is where each
      // reads without covering the mark it belongs to.
      const label = format.showDataLabels
        ? {
            show: true,
            position: asColumn && horizontal ? "right" : "top",
            fontSize: format.dataLabelFontSize,
            color: CHART_INK.secondary,
            // 100% stacking has already turned the values into shares, so the
            // label says so rather than reprinting a number that is no longer
            // the measure.
            formatter: stacked100
              ? (p: { value: number }) => `${Math.round(p.value)}%`
              : (p: { value: number }) => formatNumber(p.value, format.numberFormat),
          }
        : { show: false };
      // A label that will not fit is dropped, not drawn over its neighbour.
      // At 16px on a narrow tile the numbers ran together into one unreadable
      // string -- five overlapping labels say less than three legible ones.
      const labelLayout = { hideOverlap: true };
      if (asColumn) {
        return {
          name: s.name, type: "bar", data: s.data, barGap: "10%",
          ...(stacked ? { stack: "total" } : {}),
          label, labelLayout,
          itemStyle: {
            color,
            borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
          },
        };
      }
      return {
        name: s.name, type: "line", data: s.data, showSymbol: false,
        ...(stacked ? { stack: "total" } : {}),
        ...(type === "area" ? { areaStyle: { color, opacity: 0.18 } } : {}),
        label, labelLayout,
        lineStyle: { width: 2 }, itemStyle: { color },
      };
    }),
  } as unknown as CategoricalOptionLike;
}

/** Restate each series as its percentage share of its category's total.
 *  A category whose series sum to zero stays null rather than becoming a
 *  division by zero drawn as NaN. */
function toPercentages(series: Series[]): Series[] {
  const length = series[0]?.data.length ?? 0;
  const totals: number[] = [];
  for (let i = 0; i < length; i++) {
    totals[i] = series.reduce((sum, s) => sum + (s.data[i] ?? 0), 0);
  }
  return series.map((s) => ({
    ...s,
    data: s.data.map((value, i) =>
      value === null || !totals[i] ? null : (value / totals[i]) * 100,
    ),
  }));
}
