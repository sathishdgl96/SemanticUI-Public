import type { AskSpec } from "../api/types";
import { describeFilter } from "../reports/filters";

/** What the model actually asked for, in the user's own vocabulary.
 *
 *  Shown alongside every answer on purpose: a number from a language model is
 *  worth exactly as much as your ability to check what produced it. */
export default function SpecSummary({ spec }: { spec: AskSpec }) {
  return (
    <div className="spec-summary">
      <h4>What was asked</h4>
      <dl>
        {spec.dimensions.length > 0 && (
          <>
            <dt>Grouped by</dt>
            <dd>{spec.dimensions.join(", ")}</dd>
          </>
        )}
        <dt>Measuring</dt>
        <dd>{spec.metrics.length ? spec.metrics.join(", ") : "nothing"}</dd>
        <dt>Filters</dt>
        <dd>
          {spec.filters.length
            ? spec.filters.map(describeFilter).join("; ")
            : "No filters"}
        </dd>
      </dl>
    </div>
  );
}
