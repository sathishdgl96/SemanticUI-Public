import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { queryComposite, type CompositeDefinition } from "../api/composites";
import type { Visual } from "../api/types";
import MatrixTable from "../reports/MatrixTable";

/**
 * Asking the model a question, from inside the editor.
 *
 * A mapping nobody has run is a guess. This is the shortest path from
 * "I declared that these two columns mean the same thing" to seeing
 * whether the numbers that come back are the ones expected — including
 * the SQL, because an answer you cannot audit is one you should not act
 * on.
 *
 * The results are drawn by the report matrix, not by a table of this
 * page's own. Two tables would be two places to fix a sticky header, two
 * number formats, and two chances for the preview to disagree with the
 * report a person builds next over the same model.
 */
/** The matrix needs a visual to read its wells from. This one is not
 *  saved anywhere -- it exists for the length of a render, so the preview
 *  and a real report over the same model go through identical code. */
function previewVisual(dimensions: string[], metrics: string[]): Visual {
  return {
    id: "preview",
    type: "matrix",
    title: "",
    layout: { x: 0, y: 0, w: 12, h: 8 },
    wells: { rows: dimensions, columns: [], values: metrics },
    options: {},
    filters: [],
  };
}

export default function ModelPreview({
  id,
  definition,
}: {
  id: string;
  definition: CompositeDefinition;
}) {
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [showSql, setShowSql] = useState(false);

  const run = useMutation({
    mutationFn: () =>
      queryComposite(id, { dimensions, metrics, limit: 50 }),
  });

  // Only what the SAVED model can answer. A field added but not saved
  // would 400 on the server, and "save first" is a clearer thing to know
  // before running than after.
  const sharedNames = definition.sharedDimensions
    .map((shared) => shared.name)
    .filter(Boolean);
  const derivedNames = definition.derivedMetrics.map((metric) => metric.name);

  function toggle(list: string[], value: string, set: (next: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  const nothingPicked = dimensions.length === 0 && metrics.length === 0;

  return (
    <section className="model-section">
      <h3>Try it</h3>
      {sharedNames.length === 0 && derivedNames.length === 0 ? (
        <p className="tile-hint">
          Save a shared dimension or a derived metric and you can run the
          model here.
        </p>
      ) : (
        <>
          <div className="model-picker">
            {sharedNames.map((name) => (
              <label key={name} className="model-chip">
                <input
                  type="checkbox"
                  checked={dimensions.includes(name)}
                  onChange={() => toggle(dimensions, name, setDimensions)}
                />
                {name}
              </label>
            ))}
            {derivedNames.map((name) => (
              <label key={name} className="model-chip">
                <input
                  type="checkbox"
                  checked={metrics.includes(name)}
                  onChange={() => toggle(metrics, name, setMetrics)}
                />
                {name}
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={nothingPicked || run.isPending}
            onClick={() => run.mutate()}
            title={nothingPicked ? "Pick a field first." : undefined}
          >
            {run.isPending ? "Running…" : "Run"}
          </button>
        </>
      )}

      {run.error && (
        <p role="alert">
          {run.error instanceof ApiError
            ? run.error.message
            : "That question could not be answered."}
        </p>
      )}

      {run.data && (
        <>
          <p className="tile-hint">
            {run.data.branches.length === 1
              ? "Answered by one view — no join was needed."
              : `Answered by ${run.data.branches.length} views: ${run.data.branches.join(", ")}.`}
            {run.data.truncated && " Showing the first rows only."}
          </p>
          <div className="model-result">
            <MatrixTable visual={previewVisual(dimensions, metrics)} result={run.data} />
          </div>
          <button type="button" className="link" onClick={() => setShowSql(!showSql)}>
            {showSql ? "Hide SQL" : "Show SQL"}
          </button>
          {showSql && <pre className="sql-preview">{run.data.sql}</pre>}
        </>
      )}
    </section>
  );
}
