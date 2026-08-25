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

interface Props {
  result: TabularResult;
  /** Supplied by a parent that owns the sort -- the explorer, whose chart
   *  and saved document have to agree with the table. The rows are then
   *  expected to arrive already in that order; the table only shows which
   *  column it is. Left undefined, the table sorts for itself. */
  sort?: SortState | null;
  onSortChange?: (next: SortState | null) => void;
}

export default function ResultsTable({ result, sort: controlled, onSortChange }: Props) {
  const [own, setOwn] = useState<SortState | null>(null);
  const isControlled = controlled !== undefined;
  const sort = isControlled ? controlled : own;
  const rows = useMemo(
    () => (isControlled ? result.rows : sortRows(result.rows, own, result.columns)),
    [isControlled, result.rows, result.columns, own],
  );
  const click = (index: number) => {
    const next = nextSort(sort, index);
    if (isControlled) onSortChange?.(next);
    else setOwn(next);
  };

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
                      onClick={() => click(index)}
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
