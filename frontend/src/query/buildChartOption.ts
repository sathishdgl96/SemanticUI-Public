import { CHART_INK, SERIES_COLORS } from "./palette";
import { categoryLabelLayout } from "./renderers/categorical";

/** ECharts' own axis label size, which this option does not override. */
const AXIS_FONT_SIZE = 12;

export interface ChartSeries {
  name: string;
  data: (number | null)[];
  colorIndex: number;
}

interface BarSeriesItem {
  name: string;
  type: "bar";
  data: (number | null)[];
  barGap: string;
  itemStyle: { color: string; borderRadius: number[] };
}

interface LineSeriesItem {
  name: string;
  type: "line";
  data: (number | null)[];
  showSymbol: false;
  lineStyle: { width: number };
  itemStyle: { color: string };
}

interface ChartOptionBase {
  [key: string]: unknown;
  backgroundColor: string;
  grid: { left: number; right: number; top: number; bottom: number };
  tooltip: { trigger: string; axisPointer: { type: string } };
  legend: { show: boolean; bottom: number; textStyle: { color: string } };
  xAxis: {
    type: string;
    data: string[];
    axisLine: { lineStyle: { color: string } };
    axisLabel: {
      color: string;
      interval: number;
      rotate: number;
      width?: number;
      overflow: string;
    };
    axisTick: { show: boolean };
  };
  yAxis: {
    type: string;
    splitLine: { lineStyle: { color: string } };
    axisLabel: { color: string };
  };
}

export interface BarChartOption extends ChartOptionBase {
  series: BarSeriesItem[];
}

export interface LineChartOption extends ChartOptionBase {
  series: LineSeriesItem[];
}

export function buildChartOption(
  kind: "bar",
  categories: string[],
  series: ChartSeries[],
): BarChartOption;
export function buildChartOption(
  kind: "line",
  categories: string[],
  series: ChartSeries[],
): LineChartOption;
export function buildChartOption(
  kind: "bar" | "line",
  categories: string[],
  series: ChartSeries[],
): BarChartOption | LineChartOption;
export function buildChartOption(
  kind: "bar" | "line",
  categories: string[],
  series: ChartSeries[],
): BarChartOption | LineChartOption {
  // Every category label, slanted. The library's default drops whichever
  // labels would collide, so a month of days named one day in five -- and
  // in the explorer there is no Format pane to say otherwise. The plot
  // gives up the height the slanted text needs (see categoryLabelLayout).
  const labels = categoryLabelLayout(categories, {
    categoryLabels: "all",
    axisFontSize: AXIS_FONT_SIZE,
  });
  const base = {
    backgroundColor: "transparent",
    grid: {
      left: 48,
      right: 16,
      top: 24,
      bottom: (series.length > 1 ? 56 : 32) + labels.reserve,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: kind === "line" ? "line" : "shadow" },
    },
    legend: {
      show: series.length > 1,
      bottom: 0,
      textStyle: { color: CHART_INK.secondary },
    },
    xAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: CHART_INK.axis } },
      axisLabel: {
        color: CHART_INK.muted,
        interval: 0,
        rotate: labels.rotate,
        width: labels.width,
        overflow: "truncate",
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
  };

  if (kind === "bar") {
    return {
      ...base,
      series: series.map(
        (s): BarSeriesItem => ({
          name: s.name,
          type: "bar",
          data: s.data,
          barGap: "10%",
          itemStyle: {
            color: SERIES_COLORS[s.colorIndex % SERIES_COLORS.length],
            borderRadius: [4, 4, 0, 0],
          },
        }),
      ),
    };
  }

  return {
    ...base,
    series: series.map(
      (s): LineSeriesItem => ({
        name: s.name,
        type: "line",
        data: s.data,
        showSymbol: false,
        lineStyle: { width: 2 },
        itemStyle: {
          color: SERIES_COLORS[s.colorIndex % SERIES_COLORS.length],
        },
      }),
    ),
  };
}
