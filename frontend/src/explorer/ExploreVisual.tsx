/** Draws an explore's answer as the chosen visual type.
 *
 *  Deliberately thin: it holds no query of its own, because the explorer has
 *  already run one. Everything it draws with -- the ECharts option builder,
 *  the results table, the matrix and card renderers -- is the same code the
 *  report canvas uses, so a chart in the explorer and the tile it becomes
 *  are the same chart rather than two implementations that drift.
 */

import { useMemo } from "react";
import type { QueryResponse, Visual } from "../api/types";
import ResultsTable from "../query/ResultsTable";
import { buildVisualOption, visualTitle } from "../query/renderers";
import AutoChartAdapter from "../reports/AutoChartAdapter";
import MatrixTable from "../reports/MatrixTable";
import MultiRowCard from "../reports/MultiRowCard";

interface Props {
  visual: Visual;
  result: QueryResponse;
}

/** What an explore's chart looks like unless the visual says otherwise.
 *
 *  Every category label, slanted: the chart library's default drops any
 *  label that would touch its neighbour, and the explorer has no Format
 *  pane to turn that off, so a bar per day named one day in five with no
 *  way to see the rest. A report tile keeps the library's default and
 *  offers the choice in its Format pane, because there the author decides. */
const EXPLORER_DEFAULT_OPTIONS: Record<string, unknown> = { categoryLabels: "all" };

function kpiText(result: QueryResponse): string {
  const value = Number(result.rows[0]?.[0] ?? 0);
  // Locale pinned, for the reason given in VisualTile: the runtime default
  // groups digits differently per machine.
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "—";
}

export default function ExploreVisual({ visual, result }: Props) {
  const option = useMemo(
    () =>
      buildVisualOption(
        { ...visual, options: { ...EXPLORER_DEFAULT_OPTIONS, ...visual.options } },
        result,
      ),
    [visual, result],
  );
  const title = visualTitle(visual);

  if (visual.type === "table") return <ResultsTable result={result} />;
  if (visual.type === "matrix") return <MatrixTable visual={visual} result={result} />;
  if (visual.type === "multiCard") return <MultiRowCard visual={visual} result={result} />;
  if (visual.type === "kpi") {
    return (
      <p className="kpi-value" data-testid="kpi-value">
        {kpiText(result)}
      </p>
    );
  }
  if (!option) {
    return <p className="tile-hint">Nothing to chart for this field combination.</p>;
  }
  return (
    <>
      {title && <h3 className="chart-title">{title}</h3>}
      <AutoChartAdapter
        kind="bar"
        title={title}
        option={option}
        categories={result.rows.map((row) => String(row[0]))}
      />
    </>
  );
}
