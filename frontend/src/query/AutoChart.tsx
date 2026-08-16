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
  /** When supplied, the chart becomes interactive: clicking a mark reports
   *  its category name. Drives drill-down and cross-filtering. */
  onMarkClick?: (category: string) => void;
}

export default function AutoChart({
  kind,
  categories = [],
  series = [],
  title,
  option,
  onMarkClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the chart effect below does not have to re-run — and
  // rebuild the whole chart — every time the parent hands down a new callback
  // identity, which it does on every render.
  const clickRef = useRef(onMarkClick);
  clickRef.current = onMarkClick;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(option ?? buildChartOption(kind, categories, series));
    chart.on("click", (params: { name?: string }) => {
      if (params?.name) clickRef.current?.(params.name);
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    // The window is not the only thing that changes a chart's size: collapsing
    // a pane, resizing a tile on the grid, or switching to a page whose
    // layout differs all resize the CONTAINER while the window sits still.
    // Watching the element itself is what makes the chart track its tile
    // instead of stretching only when the browser frame moves.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(ref.current);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      chart.dispose();
    };
    // The dependency list intentionally switches shape with `option`: when a
    // caller hands AutoChart a pre-built option, only [option, title] should
    // re-trigger the effect (kind/categories/series are unused in that
    // branch and are the explorer's stale defaults for a report tile).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, option ? [option, title] : [kind, categories, series]);

  const interactive = Boolean(onMarkClick);

  return (
    <div
      ref={ref}
      className="auto-chart"
      // An SVG chart is unreachable by keyboard on its own. Enter activates
      // the first category, which is enough to drill without a mouse; the
      // breadcrumb in the tile header handles coming back up.
      role={interactive ? "button" : "img"}
      tabIndex={interactive ? 0 : undefined}
      aria-label={title}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" && categories[0]) {
          e.preventDefault();
          clickRef.current?.(categories[0]);
        }
      }}
    />
  );
}
