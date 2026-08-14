export type ChartKind = "bar" | "line" | "none";

export function chooseChart(
  dimCount: number,
  metricCount: number,
  dimType?: string,
): ChartKind {
  if (dimCount !== 1 || metricCount < 1) return "none";
  if (dimType && /DATE|TIMESTAMP/i.test(dimType)) return "line";
  return "bar";
}
