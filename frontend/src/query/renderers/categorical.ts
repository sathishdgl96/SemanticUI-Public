import type { QueryResponse, Visual } from "../../api/types";
import { pivotLegend } from "../pivotLegend";
import { CHART_INK, SERIES_COLORS } from "../palette";
import { fieldName } from "../fieldName";

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
  // Column values first, then line values: `combo` draws the leading
  // `values.length` series as bars and the rest as lines, so the order here
  // is what tells them apart downstream.
  const metricRefs = [...(visual.wells.values ?? []), ...(visual.wells.lineValues ?? [])];
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

/** How a visual's Format options translate into chart chrome. Read once and
 *  passed around, so "does this chart show a legend?" is answered in exactly
 *  one place. */
export interface FormatOptions {
  showLegend: boolean;
  legendPosition: string;
  legendTitle: string;
  legendFontSize: number;
  showDataLabels: boolean;
  dataLabelFontSize: number;
  showGridlines: boolean;
  xAxisTitle: string;
  yAxisTitle: string;
  axisFontSize: number;
  /** "compact" renders 1.2M; anything else renders 1,234,567. */
  numberFormat: string;
  /** Per-series hex overrides, applied by position. Short lists are fine:
   *  series past the end fall back to the shared palette. */
  colors: string[];
}

/** A size the author set, or the default. Guarded because `options` comes
 *  from a saved document: a string or a negative number there would otherwise
 *  reach ECharts and render nothing at all. */
function size(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 && value <= 72 ? value : fallback;
}

export function formatOptionsOf(options: Record<string, unknown>): FormatOptions {
  return {
    // Absent means "the default this build applies", not false: a report
    // saved before the Format pane existed must keep its legend.
    showLegend: options.showLegend !== false,
    legendPosition: (options.legendPosition as string) ?? "bottom",
    legendTitle: (options.legendTitle as string) ?? "",
    legendFontSize: size(options.legendFontSize, 11),
    showDataLabels: options.showDataLabels === true,
    dataLabelFontSize: size(options.dataLabelFontSize, 11),
    showGridlines: options.showGridlines !== false,
    xAxisTitle: (options.xAxisTitle as string) ?? "",
    yAxisTitle: (options.yAxisTitle as string) ?? "",
    axisFontSize: size(options.axisFontSize, 11),
    numberFormat: (options.format as string) ?? "full",
    colors: hexList(options.colors),
  };
}

/** Only well-formed hex survives. These reach an ECharts option and a `style`
 *  attribute, and a saved document is not a trusted source -- the server
 *  validates its own colour field, but a visual's options are a free-form
 *  bag by design. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function hexList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is string => typeof c === "string" && HEX.test(c));
}

/** Format a number the way the visual's Number format option asks.
 *
 *  Locale pinned to "en-US" for the reason given in VisualTile: the runtime
 *  default follows the OS, which groups digits differently per machine and
 *  makes a rendered axis nondeterministic. */
export function formatNumber(value: number, numberFormat: string): string {
  if (!Number.isFinite(value)) return "";
  return numberFormat === "compact"
    ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)
    : new Intl.NumberFormat("en-US").format(value);
}

export const axisChrome = {
  /** Room for the chrome around the plot.
   *
   *  A side legend needs width, not height, and an axis title needs a line of
   *  its own -- reserving a flat 48px at the bottom for every case is what
   *  made a bottom legend paint over the bars. The legend is also `scroll`
   *  (below), so it stays one row however many series there are and this
   *  reservation stays true. */
  grid: (hasLegend: boolean, format?: FormatOptions) => {
    const position = format?.legendPosition ?? "bottom";
    const side = hasLegend && (position === "left" || position === "right");
    const legendSize = format?.legendFontSize ?? 11;
    return {
      left: 48 + (side && position === "left" ? legendSize * 8 : 0),
      right: 16 + (side && position === "right" ? legendSize * 8 : 0),
      top: 16 + (hasLegend && position === "top" ? legendSize * 2.4 : 0),
      bottom:
        (hasLegend && position === "bottom" ? legendSize * 2.4 : 0) +
        (format?.xAxisTitle ? 22 : 0) +
        28,
    };
  },
  categoryAxis: (categories: string[], format?: FormatOptions) => ({
    type: "category" as const,
    data: categories,
    name: format?.xAxisTitle || undefined,
    nameLocation: "middle" as const,
    nameGap: 28,
    nameTextStyle: { color: CHART_INK.secondary, fontSize: format?.axisFontSize ?? 11 },
    axisLine: { lineStyle: { color: CHART_INK.axis } },
    axisLabel: { color: CHART_INK.muted, fontSize: format?.axisFontSize ?? 11 },
    axisTick: { show: false },
  }),
  valueAxis: (showGridlines = true, format?: FormatOptions) => ({
    type: "value" as const,
    name: format?.yAxisTitle || undefined,
    nameTextStyle: { color: CHART_INK.secondary, fontSize: format?.axisFontSize ?? 11 },
    splitLine: { show: showGridlines, lineStyle: { color: CHART_INK.grid } },
    axisLabel: {
      color: CHART_INK.muted,
      fontSize: format?.axisFontSize ?? 11,
      // The axis reads in the same units as the labels and the cards do.
      formatter: (value: number) => formatNumber(value, format?.numberFormat ?? "full"),
    },
  }),
  /** A legend is only worth the space when there is more than one series to
   *  tell apart -- unless the author asked for it explicitly. */
  legend: (count: number, format?: FormatOptions) => {
    const show = (format ? format.showLegend : true) && count > 1;
    const position = format?.legendPosition ?? "bottom";
    const anchor =
      position === "top"
        ? { top: 0 }
        : position === "left"
          ? { left: 0, orient: "vertical" as const }
          : position === "right"
            ? { right: 0, orient: "vertical" as const }
            : { bottom: 0 };
    return {
      show,
      ...anchor,
      // Paginated rather than wrapped. Twenty-five series used to wrap into
      // five rows and paint straight over the chart, because the grid below
      // reserves a fixed band for it. One row with arrows cannot overflow.
      type: "scroll" as const,
      pageIconColor: CHART_INK.secondary,
      pageTextStyle: { color: CHART_INK.muted },
      textStyle: {
        color: CHART_INK.secondary,
        fontSize: format?.legendFontSize ?? 11,
      },
    };
  },
  /** The author's colour for this series, or the shared palette's.
   *
   *  Overridden HERE rather than by touching the palette: `palette.ts` is the
   *  product's colour identity and is deliberately never edited or reordered,
   *  so a per-visual choice has to be a per-visual choice. */
  color: (index: number, format?: FormatOptions) =>
    format?.colors[index] ?? SERIES_COLORS[index % SERIES_COLORS.length],

  /** ECharts has no legend title, so it is drawn as a second `title` anchored
   *  to the same edge the legend sits on. Returns [] when there is nothing to
   *  draw, which is the shape `title` wants anyway. */
  legendTitle: (format: FormatOptions, shown: boolean) => {
    if (!shown || !format.legendTitle) return [];
    const at =
      format.legendPosition === "top"
        ? { left: 0, top: 0 }
        : format.legendPosition === "left"
          ? { left: 0, top: 0 }
          : format.legendPosition === "right"
            ? { right: 0, top: 0 }
            : { left: 0, bottom: 0 };
    return [
      {
        text: format.legendTitle,
        ...at,
        textStyle: {
          color: CHART_INK.secondary,
          fontSize: format.legendFontSize,
          fontWeight: 600,
        },
      },
    ];
  },
};
