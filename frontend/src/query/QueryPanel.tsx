import { useMemo } from "react";
import type { QueryResponse, SemanticViewDetail } from "../api/types";
import type { Selection } from "../explorer/FieldPanel";
import AutoChart from "./AutoChart";
import { chooseChart } from "./chooseChart";
import ResultsTable from "./ResultsTable";
import SqlPreview from "./SqlPreview";

interface Props {
  result: QueryResponse;
  detail: SemanticViewDetail;
  selection: Selection;
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

export default function QueryPanel({ result, detail, selection }: Props) {
  const dimName = selection.dimensions[0] ? fieldName(selection.dimensions[0]) : undefined;
  const dimCol = result.columns.find(
    (c) => c.name.toUpperCase() === dimName?.toUpperCase(),
  );
  const kind = chooseChart(
    selection.dimensions.length,
    selection.metrics.length,
    dimCol?.type,
  );

  // Referentially stable across re-renders that don't change the underlying
  // data (e.g. a background refetch of `detail`), so AutoChart's effect
  // doesn't dispose/reinit the chart when nothing actually changed.
  const categories = useMemo(() => {
    if (!dimCol) return [];
    const dimIndex = result.columns.indexOf(dimCol);
    return result.rows.map((row) => String(row[dimIndex] ?? ""));
  }, [result, dimCol]);

  const series = useMemo(() => {
    if (!dimCol) return [];
    return selection.metrics.flatMap((ref) => {
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
  }, [result, detail.metrics, selection.metrics, dimCol]);

  let chart = null;
  if (kind !== "none" && dimCol) {
    // A single series is named by this title instead of a legend box; with
    // 2+ series the title still names the whole chart while the legend
    // distinguishes the series.
    const metricNames = selection.metrics.map(fieldName);
    const title = dimName ? `${metricNames.join(", ")} by ${dimName}` : metricNames.join(", ");
    chart = (
      <>
        <h3 className="chart-title">{title}</h3>
        <AutoChart kind={kind} categories={categories} series={series} title={title} />
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
