/**
 * One sort, three places it has to agree.
 *
 * A click on a column header in the Data tab is the same request as the
 * explore's saved `orderBy` and the query's ORDER BY: "these rows, in
 * this order". It used to live only in the table -- the chart kept the
 * order the query returned, and saving the explore forgot the sort --
 * so a date axis stayed shuffled however the table was sorted. These
 * helpers translate between the header's (column index, direction) and
 * the field reference the query and the document speak in.
 */

import { columnIndexOf, fieldName } from "../query/fieldName";
import { sortRows, type SortState } from "../query/sortRows";

export interface OrderBy {
  field: string;
  direction: "asc" | "desc";
}

interface Columned {
  columns: { name: string }[];
}

/** The header state an ORDER BY shows as, or null when the ordered field
 *  is not a column of this result (it was removed from a well, say). */
export function sortStateFor(columns: Columned["columns"], orderBy: OrderBy[]): SortState | null {
  const first = orderBy[0];
  if (!first) return null;
  const index = columnIndexOf(columns, first.field);
  return index < 0 ? null : { index, direction: first.direction };
}

/** The ORDER BY a header click means: the clicked column, named as the
 *  field reference it was selected by. Empty for "no sort", and for a
 *  column that maps to no selected field. */
export function orderByFor(
  columns: Columned["columns"],
  sort: SortState | null,
  refs: string[],
): OrderBy[] {
  if (!sort) return [];
  const column = columns[sort.index];
  if (!column) return [];
  const name = column.name.toUpperCase();
  const ref = refs.find((r) => fieldName(r).toUpperCase() === name);
  return ref ? [{ field: ref, direction: sort.direction }] : [];
}

/** Only the entries that name a selected field. The query API refuses to
 *  order by a field it does not return, and the explore's schema refuses
 *  to store one -- so a sort whose field left the wells is dropped rather
 *  than failing every run and every save after it. */
export function pruneOrderBy(orderBy: OrderBy[], refs: string[]): OrderBy[] {
  const known = new Set(refs.map((r) => r.toUpperCase()));
  return orderBy.filter((entry) => known.has(entry.field.toUpperCase()));
}

/** The result with its rows in ORDER BY order -- what the chart and the
 *  table both draw, so a sort in one is the sort in the other. A no-op
 *  on rows the query already ordered this way: the sort is stable. */
export function applyOrder<T extends Columned & { rows: unknown[][] }>(
  result: T,
  orderBy: OrderBy[],
): T {
  const sort = sortStateFor(result.columns, orderBy);
  if (!sort) return result;
  return {
    ...result,
    rows: sortRows(result.rows, sort, result.columns as { name: string; type: string }[]),
  };
}
