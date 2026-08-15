import { useMemo } from "react";
import type { QueryResponse, SemanticViewDetail } from "../api/types";
import type { Wells } from "../explorer/wells";
import AutoChart from "./AutoChart";
import type { ChartSeries } from "./buildChartOption";
import { chooseChartForWells } from "./chooseChart";
import { pivotLegend } from "./pivotLegend";
import ResultsTable from "./ResultsTable";
import SqlPreview from "./SqlPreview";

interface Props {
  result: QueryResponse;
  detail: SemanticViewDetail;
  wells: Wells;
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

export default function QueryPanel({ result, detail, wells }: Props) {
  const axisRef = wells.axis[0];
  const legendRef = wells.legend[0];
  const axisName = axisRef ? fieldName(axisRef) : undefined;
  const legendName = legendRef ? fieldName(legendRef) : undefined;
  const axisCol = result.columns.find(
    (c) => c.name.toUpperCase() === axisName?.toUpperCase(),
  );
  const hasLegend = wells.legend.length === 1;
  const kind = chooseChartForWells(
    wells.axis.length,
    wells.legend.length,
    wells.values.length,
    axisCol?.type,
  );

  const firstMetricRef = wells.values[0];
  const firstMetricName = firstMetricRef ? fieldName(firstMetricRef) : undefined;

  // Referentially stable across re-renders that don't change the underlying
  // data (e.g. a background refetch of `detail`), so AutoChart's effect
  // doesn't dispose/reinit the chart when nothing actually changed.
  const categories = useMemo(() => {
    if (!axisCol) return [];
    const axisIndex = result.columns.indexOf(axisCol);
    return result.rows.map((row) => String(row[axisIndex] ?? ""));
  }, [result, axisCol]);

  const legendPivot = useMemo(() => {
    if (!hasLegend || !axisName || !legendName || !firstMetricName) return null;
    return pivotLegend(result, axisName, legendName, firstMetricName);
  }, [result, hasLegend, axisName, legendName, firstMetricName]);

  const seriesByMetric = useMemo((): ChartSeries[] => {
    if (!axisCol) return [];
    return wells.values.flatMap((ref) => {
      const name = fieldName(ref);
      const colIndex = result.columns.findIndex(
        (c) => c.name.toUpperCase() === name.toUpperCase(),
      );
      if (colIndex < 0) return [];
      // Stable identity: color slot = metric's index in the view's metric list.
      const colorIndex = Math.max(
        0,
        detail.metrics.findIndex(
          (m) => m.name.toUpperCase() === name.toUpperCase(),
        ),
      );
      return [
        {
          name,
          colorIndex,
          data: result.rows.map((row) => {
            const value = row[colIndex];
            return value === null || value === undefined ? null : Number(value);
          }),
        },
      ];
    });
  }, [result, detail.metrics, wells.values, axisCol]);

  const chartCategories = legendPivot ? legendPivot.categories : categories;
  const series = legendPivot ? legendPivot.series : seriesByMetric;

  let chart = null;
  if (kind !== "none" && axisCol) {
    // A single series is named by this title instead of a legend box; with
    // 2+ series the title still names the whole chart while the legend
    // distinguishes the series. When a well-legend is active, only the
    // first metric is charted (a legend splits one measure across
    // categories), so the title always names just that metric.
    const metricNames = hasLegend
      ? firstMetricName ? [firstMetricName] : []
      : wells.values.map(fieldName);
    const title = axisName ? `${metricNames.join(", ")} by ${axisName}` : metricNames.join(", ");
    chart = (
      <>
        <h3 className="chart-title">{title}</h3>
        {hasLegend && firstMetricName && (
          <p className="chart-note">
            Charting {firstMetricName} only — a legend splits a single measure. The
            table shows all selected fields.
          </p>
        )}
        <AutoChart kind={kind} categories={chartCategories} series={series} title={title} />
      </>
    );
  }

  return (
    <div className="query-panel">
      {chart}
      <ResultsTable result={result} />
      <SqlPreview sql={result.sql} />
    </div>
  );
}
