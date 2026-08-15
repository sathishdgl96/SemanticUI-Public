import type { QueryResponse, Visual } from "../../api/types";
import { pivotLegend } from "../pivotLegend";
import { CHART_INK, SERIES_COLORS } from "../palette";

export interface Series {
  name: string;
  colorIndex: number;
  data: (number | null)[];
}

// A deliberately loose ECharts option shape shared by every renderer in this
// folder. buildChartOption.ts's ChartOptionBase is the established precedent
// for this "index signature + a few named fields" pattern in this codebase,
// but it hard-codes a bar/line-only xAxis/yAxis/series shape, so it can't
// describe pie (no axes) or scatter (value axes, grouped series) without
// widening it into something that no longer matches its own two callers.
// Visual.type is a plain `string` (not the VisualType literal union), so
// buildVisualOption has no literal argument to dispatch bar/line/pie/scatter
// overloads on the way buildChartOption("bar"|"line", ...) does — one shared
// return type, structurally loose enough for every branch, is the option
// left.
//
// The fields the renderer tests dot into (series[].itemStyle, .lineStyle,
// .data, option.legend, .xAxis, .yAxis) are declared required rather than
// optional: this project resolves optional-chain access strictly, so an
// `xAxis?:` here would make `option.xAxis.type` fail to compile even in the
// scatter branch that always sets it. Not every visual type actually
// populates every one of these (pie has no axes; bar has no lineStyle) —
// each builder bridges that gap with a single `as unknown as
// EChartsOptionLike` at its own return statement, disclosed there, rather
// than by lying to every caller with fields typed as always-present. Any
// field a given visual type doesn't use, and that no test dots into, falls
// through the index signature as `unknown` rather than being declared `any`.
export interface LooseRecord {
  [key: string]: unknown;
}

export interface DataPointLike extends LooseRecord {
  name: string;
  itemStyle: LooseRecord;
}

export interface SeriesItemLike extends LooseRecord {
  type: string;
  data: DataPointLike[];
  itemStyle: LooseRecord;
  lineStyle: LooseRecord;
}

export interface EChartsOptionLike extends LooseRecord {
  series: SeriesItemLike[];
  legend: LooseRecord;
  xAxis: LooseRecord;
  yAxis: LooseRecord;
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

function columnIndex(result: QueryResponse, name: string): number {
  return result.columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
}

/** Axis categories plus one series per metric (or per legend value). */
export function categoricalSeries(
  visual: Visual,
  result: QueryResponse,
): { categories: string[]; series: Series[] } {
  const axisRef = (visual.wells.axis ?? [])[0];
  const legendRef = (visual.wells.legend ?? [])[0];
  const metricRefs = visual.wells.values ?? [];
  if (!axisRef || metricRefs.length === 0) return { categories: [], series: [] };

  if (legendRef) {
    // A legend splits ONE measure into a series per legend value.
    return pivotLegend(result, fieldName(axisRef), fieldName(legendRef), fieldName(metricRefs[0]));
  }

  const axisIndex = columnIndex(result, fieldName(axisRef));
  if (axisIndex < 0) return { categories: [], series: [] };
  const categories = result.rows.map((row) => String(row[axisIndex] ?? ""));
  const series = metricRefs.flatMap((ref, i) => {
    const index = columnIndex(result, fieldName(ref));
    if (index < 0) return [];
    return [{
      name: fieldName(ref),
      colorIndex: i,
      data: result.rows.map((row) => {
        const value = row[index];
        return value === null || value === undefined ? null : Number(value);
      }),
    }];
  });
  return { categories, series };
}

export const axisChrome = {
  grid: (hasLegend: boolean) => ({
    left: 48, right: 16, top: 16, bottom: hasLegend ? 48 : 28,
  }),
  categoryAxis: (categories: string[]) => ({
    type: "category" as const,
    data: categories,
    axisLine: { lineStyle: { color: CHART_INK.axis } },
    axisLabel: { color: CHART_INK.muted },
    axisTick: { show: false },
  }),
  valueAxis: () => ({
    type: "value" as const,
    splitLine: { lineStyle: { color: CHART_INK.grid } },
    axisLabel: { color: CHART_INK.muted },
  }),
  legend: (count: number) => ({
    show: count > 1,
    bottom: 0,
    textStyle: { color: CHART_INK.secondary },
  }),
  color: (index: number) => SERIES_COLORS[index % SERIES_COLORS.length],
};
