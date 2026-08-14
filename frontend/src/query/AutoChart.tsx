import * as echarts from "echarts";
import { useEffect, useRef } from "react";
import { buildChartOption, type ChartSeries } from "./buildChartOption";

interface Props {
  kind: "bar" | "line";
  categories: string[];
  series: ChartSeries[];
  title: string;
}

export default function AutoChart({ kind, categories, series, title }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(buildChartOption(kind, categories, series));
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [kind, categories, series]);

  return <div ref={ref} className="auto-chart" role="img" aria-label={title} />;
}
