import * as echarts from "echarts";
import { useEffect, useRef } from "react";
import type { EChartsOptionLike } from "./renderers/categorical";
import { buildChartOption, type ChartSeries } from "./buildChartOption";

interface Props {
  kind: "bar" | "line";
  categories?: string[];
  series?: ChartSeries[];
  title: string;
  /** When supplied, used verbatim instead of building an option from
   *  kind/categories/series — lets callers (e.g. report tiles) hand AutoChart
   *  an already-composed option (pie, scatter, stacked, …) that
   *  buildChartOption cannot express, without disturbing the explorer's
   *  existing kind/categories/series path. */
  option?: EChartsOptionLike;
}

export default function AutoChart({ kind, categories = [], series = [], title, option }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(option ?? buildChartOption(kind, categories, series));
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
    // The dependency list intentionally switches shape with `option`: when a
    // caller hands AutoChart a pre-built option, only [option, title] should
    // re-trigger the effect (kind/categories/series are unused in that
    // branch and are the explorer's stale defaults for a report tile).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, option ? [option, title] : [kind, categories, series]);

  return <div ref={ref} className="auto-chart" role="img" aria-label={title} />;
}
