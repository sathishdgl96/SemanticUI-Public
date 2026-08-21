import type { QueryResponse, Visual } from "../api/types";
import { columnIndexOf, fieldName } from "../query/fieldName";

interface Props {
  visual: Visual;
  result: QueryResponse;
}


function formatNumber(value: unknown, compact: boolean): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return compact
    ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(n)
    : new Intl.NumberFormat("en-US").format(n);
}

/** One card per row: the dimensions as a heading, the measures beneath it.
 *  PowerBI's multi-row card, which is the readable answer when a table would
 *  be three columns wide and forty rows long. */
export default function MultiRowCard({ visual, result }: Props) {
  const dimensionRefs = visual.wells.dimensions ?? [];
  const metricRefs = visual.wells.metrics ?? [];
  const compact = visual.options.format === "compact";

  const dimIdx = dimensionRefs.map((ref) => columnIndexOf(result.columns, ref));
  const metricIdx = metricRefs.map((ref) => columnIndexOf(result.columns, ref));
  if (metricIdx.some((i) => i < 0)) {
    return <p className="tile-hint">Waiting for these fields to come back from the view.</p>;
  }

  if (result.rows.length === 0) {
    return <p className="tile-hint">No rows for the current filters.</p>;
  }

  return (
    <ul className="multi-card">
      {result.rows.map((row, i) => (
        <li className="multi-card-row" key={i}>
          {dimIdx.length > 0 && (
            <p className="multi-card-title">
              {dimIdx.map((index) => String(row[index] ?? "")).join(" · ")}
            </p>
          )}
          <dl className="multi-card-values">
            {metricRefs.map((ref, m) => (
              <div key={ref}>
                <dt>{fieldName(ref)}</dt>
                <dd>{formatNumber(row[metricIdx[m]], compact)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
