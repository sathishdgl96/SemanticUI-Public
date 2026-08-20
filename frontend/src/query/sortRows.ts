import type { ColumnInfo } from "../api/types";

export type SortDirection = "asc" | "desc";

export interface SortState {
  index: number;
  direction: SortDirection;
}

/** Numeric Snowflake types, by the names the gateway reports. */
const NUMERIC = /^(FIXED|REAL|NUMBER|FLOAT|DECIMAL|INT)/i;

/**
 * The sort a click produces: ascending, then descending, then none.
 *
 * The third state matters. What the query returned is not an arbitrary
 * order -- it is the ordering the semantic layer chose -- so there has to
 * be a way back to it that is not "reload the page".
 */
export function nextSort(current: SortState | null, index: number): SortState | null {
  if (!current || current.index !== index) return { index, direction: "asc" };
  if (current.direction === "asc") return { index, direction: "desc" };
  return null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Rows in sort order. Never mutates its input, and stable, so equal values
 * keep the order the query gave them.
 *
 * Comparison follows the COLUMN TYPE rather than the JavaScript value: a
 * numeric column sorted as text puts 200 before 30, which reads as a broken
 * table rather than as a sorting convention.
 */
export function sortRows(
  rows: unknown[][],
  sort: SortState | null,
  columns: ColumnInfo[],
): unknown[][] {
  if (!sort) return rows;
  const numeric = NUMERIC.test(columns[sort.index]?.type ?? "");
  const sign = sort.direction === "asc" ? 1 : -1;

  return rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => {
      const left = a.row[sort.index];
      const right = b.row[sort.index];
      // Blanks sort last whichever way the column is pointed: a column of
      // empties at the top tells you nothing and hides the row you sorted
      // to find.
      if (isBlank(left) || isBlank(right)) {
        if (isBlank(left) && isBlank(right)) return a.position - b.position;
        return isBlank(left) ? 1 : -1;
      }
      let order: number;
      if (numeric) {
        order = Number(left) - Number(right);
      } else {
        order = String(left).localeCompare(String(right), undefined, {
          sensitivity: "base",
          numeric: true,
        });
      }
      return order !== 0 ? order * sign : a.position - b.position;
    })
    .map((entry) => entry.row);
}
