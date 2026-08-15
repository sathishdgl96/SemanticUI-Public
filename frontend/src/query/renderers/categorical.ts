import type { QueryResponse, Visual } from "../../api/types";
import { pivotLegend } from "../pivotLegend";
import { CHART_INK, SERIES_COLORS } from "../palette";

export interface Series {
  name: string;
  colorIndex: number;
  data: (number | null)[];
}

// Deliberately loose ECharts option shapes for the renderers in this folder.
// buildChartOption.ts's ChartOptionBase is the established precedent for
// this "index signature + a few named fields" pattern in this codebase, but
// it hard-codes a bar/line-only xAxis/yAxis/series shape, so it can't
// describe pie (no axes) or scatter (value axes, grouped series) without
// widening it into something that no longer matches its own two callers.
//
// Pie, scatter and categorical (bar/line/area) each get their OWN accurate
// type below — accurate meaning a caller can trust every field the type
// claims is actually there at runtime. In particular PieOptionLike has no
// xAxis/yAxis: a pie chart never renders cartesian axes, so a type that
// claimed otherwise would let `option.xAxis.type` type-check and then throw
// on `undefined` at runtime for every pie. EChartsOptionLike is the union of
// the three — the type pieOption/scatterOption/buildVisualOption actually
// return, and what AutoChart's `option` prop accepts. A member of that
// union (what pieOption/scatterOption already return) is assignable into it
// with no cast; only buildVisualOption's categorical branch, which builds
// its object inline from a bar/line ternary, still needs one — see the
// comment at that return site.
//
// Fields a test dots two levels into (series[].itemStyle, .lineStyle,
// .data, option.legend, .xAxis, .yAxis) are required rather than optional
// on the type that's honest about having them: this project resolves
// optional-chain access strictly, so an `xAxis?:` would make
// `option.xAxis.type` fail to compile even where it's genuinely always
// set. Any field a given visual type doesn't use, and that no test dots
// into, falls through the index signature as `unknown` rather than being
// declared `any`.
export interface LooseRecord {
  [key: string]: unknown;
}

export interface PieDataPointLike extends LooseRecord {
  name: string;
  itemStyle: LooseRecord;
}

export interface PieSeriesItemLike extends LooseRecord {
  type: string;
  data: PieDataPointLike[];
}

export interface PieOptionLike extends LooseRecord {
  legend: LooseRecord;
  series: PieSeriesItemLike[];
}

export interface ScatterSeriesItemLike extends LooseRecord {
  type: string;
  data: [number, number][];
  symbolSize: number;
  itemStyle: LooseRecord;
}

export interface ScatterOptionLike extends LooseRecord {
  legend: LooseRecord;
  xAxis: LooseRecord;
  yAxis: LooseRecord;
  series: ScatterSeriesItemLike[];
}

export interface CategoricalSeriesItemLike extends LooseRecord {
  type: string;
  data: (number | null)[];
  itemStyle: LooseRecord;
  lineStyle: LooseRecord;
}

export interface CategoricalOptionLike extends LooseRecord {
  legend: LooseRecord;
  xAxis: LooseRecord;
  yAxis: LooseRecord;
  series: CategoricalSeriesItemLike[];
}

export type EChartsOptionLike = PieOptionLike | ScatterOptionLike | CategoricalOptionLike;

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
