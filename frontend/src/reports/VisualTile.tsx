import { useMemo } from "react";
import { ApiError } from "../api/client";
import type { QueryResponse, ViewRef, Visual } from "../api/types";
import ResultsTable from "../query/ResultsTable";
import { buildVisualOption, visualTitle } from "../query/renderers";
import AutoChartAdapter from "./AutoChartAdapter";
import { useVisualQuery } from "./useVisualQuery";

interface Props {
  visual: Visual;
  view: ViewRef;
  selected: boolean;
  onSelect: (id: string) => void;
}

function kpiText(result: QueryResponse, format: unknown): string {
  const value = Number(result.rows[0]?.[0] ?? 0);
  if (!Number.isFinite(value)) return "—";
  // Locale pinned to "en-US" rather than left as the runtime default: the
  // brief's original `new Intl.NumberFormat(undefined, ...)` inherits the
  // OS/ICU locale, which on this machine resolves to "en-IN" and groups
  // digits as "12,34,567" instead of "1,234,567" — making the formatted
  // value (and the test asserting it) nondeterministic across environments.
  return format === "compact"
    ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)
    : new Intl.NumberFormat("en-US").format(value);
}

export default function VisualTile({ visual, view, selected, onSelect }: Props) {
  const { problems, ready, query } = useVisualQuery(view, visual);
  const title = visualTitle(visual);
  const option = useMemo(
    () => (query.data ? buildVisualOption(visual, query.data) : null),
    [visual, query.data],
  );

  let body: React.ReactNode;
  if (!ready) {
    body = <p className="tile-hint">This visual needs fields — {problems[0]}</p>;
  } else if (query.isLoading) {
    body = <p className="tile-hint">Loading…</p>;
  } else if (query.isError) {
    body = (
      <p role="alert" className="tile-error">
        {query.error instanceof ApiError ? query.error.message : "Query failed"}
      </p>
    );
  } else if (query.data) {
    if (visual.type === "kpi") {
      body = (
        <p className="kpi-value" data-testid="kpi-value">
          {kpiText(query.data, visual.options.format)}
        </p>
      );
    } else if (visual.type === "table") {
      body = <ResultsTable result={query.data} />;
    } else if (option) {
      body = <AutoChartAdapter kind="bar" title={title} option={option} />;
    } else {
      body = <p className="tile-hint">Nothing to chart for this field combination.</p>;
    }
  }

  return (
    <section
      className={selected ? "tile selected" : "tile"}
      aria-label={title || "Untitled visual"}
      onMouseDown={() => onSelect(visual.id)}
    >
      <header className="tile-head">
        <h3>{title || "Untitled visual"}</h3>
      </header>
      <div className="tile-body">{body}</div>
    </section>
  );
}
