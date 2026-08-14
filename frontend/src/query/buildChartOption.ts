import { CHART_INK, SERIES_COLORS } from "./palette";

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
    axisLabel: { color: string };
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
  const base = {
    backgroundColor: "transparent",
    grid: { left: 48, right: 16, top: 24, bottom: series.length > 1 ? 56 : 32 },
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
      axisLabel: { color: CHART_INK.muted },
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
