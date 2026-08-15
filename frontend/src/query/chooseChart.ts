export type ChartKind = "bar" | "line" | "none";

export function chooseChartForWells(
  axisCount: number,
  // Legend presence doesn't change the chart kind (only which series get
  // built downstream by pivotLegend) — kept as a positional parameter to
  // match the wells shape at call sites; prefixed so noUnusedParameters
  // doesn't flag it.
  _legendCount: number,
  metricCount: number,
  axisType?: string,
): ChartKind {
  if (axisCount !== 1 || metricCount < 1) return "none";
  if (axisType && /DATE|TIMESTAMP/i.test(axisType)) return "line";
  return "bar";
}
