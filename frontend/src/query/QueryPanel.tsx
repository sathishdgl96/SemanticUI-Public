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

  let chart = null;
  if (kind !== "none" && dimCol) {
    const dimIndex = result.columns.indexOf(dimCol);
    const categories = result.rows.map((row) => String(row[dimIndex] ?? ""));
    const series = selection.metrics.flatMap((ref) => {
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
    chart = <AutoChart kind={kind} categories={categories} series={series} />;
  }

  return (
    <div className="query-panel">
      {chart}
      <ResultsTable result={result} />
      <SqlPreview sql={result.sql} />
    </div>
  );
}
