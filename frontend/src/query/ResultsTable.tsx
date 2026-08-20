import { useMemo, useState } from "react";
import type { ColumnInfo } from "../api/types";
import { nextSort, sortRows, type SortState } from "./sortRows";

const ARROW: Record<string, string> = { asc: "↑", desc: "↓" };
const ARIA_SORT: Record<string, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

/** Only what this component reads. Narrower than QueryResponse on purpose:
 *  an Ask answer has no sfqid, and demanding one would force callers to
 *  invent a field rather than express what they actually have. */
export interface TabularResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
}

export default function ResultsTable({ result }: { result: TabularResult }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const rows = useMemo(
    () => sortRows(result.rows, sort, result.columns),
    [result.rows, result.columns, sort],
  );

  return (
    <div className="results">
      {result.truncated && (
        <p className="banner">
          Results truncated to {result.rows.length} rows.
          {/* Said plainly: sorting reorders what is here, and what is here
              is not everything. */}
          {" Sorting orders these rows, not the whole result."}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {result.columns.map((col, index) => {
                const active = sort?.index === index;
                return (
                  <th
                    key={col.name}
                    scope="col"
                    aria-sort={active ? ARIA_SORT[sort.direction] : "none"}
                  >
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() => setSort((current) => nextSort(current, index))}
                    >
                      {col.name}
                      <span className="th-sort-arrow" aria-hidden="true">
                        {active ? ARROW[sort.direction] : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j}>{value === null ? "" : String(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
