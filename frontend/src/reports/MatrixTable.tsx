import { useEffect, useRef, useState } from "react";
import type { QueryResponse, Visual } from "../api/types";
import { type SortDirection } from "../query/sortRows";
import { sortTree } from "./matrixSort";
import { columnIndexOf, fieldName } from "../query/fieldName";

interface Props {
  visual: Visual;
  result: QueryResponse;
}

/** Which header a sort is on. The row labels are one key; every measure
 *  under every column header is `${columnKey}:${measureIndex}`, and the
 *  row-total block uses TOTAL_KEY in place of a column. Both sentinels
 *  hold a NUL, which no Snowflake value can contain, so neither can be
 *  confused with a real column key. */
const LABEL_KEY = "\u0000label";
const TOTAL_KEY = "\u0000total";

interface MatrixSort {
  key: string;
  direction: SortDirection;
}

const ARROW: Record<SortDirection, string> = { asc: "↑", desc: "↓" };


function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  return String(value);
}

/** One node of the stepped row tree. Parents carry aggregates over their
 *  descendants, so a collapsed group still shows its subtotal -- the way
 *  PowerBI's matrix (and an Excel PivotTable) reads. */
interface RowNode {
  label: string;
  key: string;
  depth: number;
  children: RowNode[];
  /** columnKey -> per-measure sums. "" is the only key when no column
   *  grouping is on the matrix. */
  totals: Map<string, number[]>;
}

/** A pivot in PowerBI's stepped layout: nested row groups down the side with
 *  expand/collapse, one optional column grouping across the top, measures in
 *  the cells, subtotals on every group row and a grand total.
 *
 *  Pivoting happens here rather than in SQL because the query already returns
 *  every (row, column) combination -- reshaping it client-side keeps the
 *  semantic query identical to every other visual's, so a matrix and a table
 *  over the same fields can never disagree about the numbers. */
export default function MatrixTable({ visual, result }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  //: Both header rows are sticky, and the second has to sit under the
  //: first rather than on top of it. The first row's height is not
  //: knowable from CSS -- it holds the column grouping, whose text wraps
  //: and whose font scales with the tile -- so it is measured and handed
  //: to the stylesheet.
  const groupRow = useRef<HTMLTableRowElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const row = groupRow.current;
    const box = scroller.current;
    if (!box) return;
    const measure = () => {
      box.style.setProperty(
        "--matrix-head-offset",
        `${row ? Math.round(row.getBoundingClientRect().height) : 0}px`,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !row) return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  });
  const [sort, setSort] = useState<MatrixSort | null>(null);

  /** Ascending, descending, then back to the query's own order -- which is
   *  the semantic layer's, and worth being able to return to. */
  const toggleSort = (key: string) =>
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  const ariaSort = (key: string): "ascending" | "descending" | "none" =>
    sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  const arrow = (key: string) => (sort?.key === key ? ARROW[sort.direction] : "");

  const rowRefs = visual.wells.rows ?? [];
  const columnRef = (visual.wells.columns ?? [])[0];
  const valueRefs = visual.wells.values ?? [];
  const showTotals = visual.options.subtotals !== false;

  const rowIdx = rowRefs.map((ref) => columnIndexOf(result.columns, ref));
  const colIdx = columnRef ? columnIndexOf(result.columns, columnRef) : -1;
  const valueIdx = valueRefs.map((ref) => columnIndexOf(result.columns, ref));

  if (rowIdx.some((i) => i < 0) || valueIdx.some((i) => i < 0)) {
    return <p className="tile-hint">Waiting for these fields to come back from the view.</p>;
  }

  // Column keys in first-seen order: the query's own ordering is the one the
  // user's filters and the semantic view produced, so re-sorting here would
  // silently disagree with the table visual over the same fields.
  const columnKeys: string[] = [];
  if (colIdx >= 0) {
    for (const row of result.rows) {
      const key = formatValue(row[colIdx]);
      if (!columnKeys.includes(key)) columnKeys.push(key);
    }
  }

  const addInto = (totals: Map<string, number[]>, colKey: string, row: unknown[]) => {
    const existing = totals.get(colKey) ?? valueIdx.map(() => 0);
    // Summed rather than overwritten: two source rows can land in the same
    // cell whenever the query selects a dimension the matrix does not show.
    totals.set(
      colKey,
      existing.map((total, v) => total + Number(row[valueIdx[v]] ?? 0)),
    );
  };

  // Build the row tree, accumulating every source row into its leaf AND all
  // of its ancestors -- that is what makes group rows carry subtotals.
  const root: RowNode = { label: "", key: "", depth: -1, children: [], totals: new Map() };
  const nodes = new Map<string, RowNode>();
  for (const row of result.rows) {
    const colKey = colIdx >= 0 ? formatValue(row[colIdx]) : "";
    addInto(root.totals, colKey, row);
    let parent = root;
    let key = "";
    for (let depth = 0; depth < rowIdx.length; depth++) {
      const label = formatValue(row[rowIdx[depth]]);
      key = key ? `${key}\u0000${label}` : label;
      let node = nodes.get(key);
      if (!node) {
        node = { label, key, depth, children: [], totals: new Map() };
        nodes.set(key, node);
        parent.children.push(node);
      }
      addInto(node.totals, colKey, row);
      parent = node;
    }
  }

  const headerColumns = colIdx >= 0 ? columnKeys : [""];
  const measureLabels = valueRefs.map(fieldName);
  const showRowTotal = colIdx >= 0 && showTotals;

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowTotal = (node: RowNode, v: number): number => {
    let sum = 0;
    for (const values of node.totals.values()) sum += values[v];
    return sum;
  };

  const cellsFor = (node: RowNode) => (
    <>
      {headerColumns.map((colKey) =>
        measureLabels.map((label, v) => (
          <td key={`${colKey}:${label}`} className="numeric">
            {node.totals.has(colKey) ? formatValue(node.totals.get(colKey)![v]) : ""}
          </td>
        )),
      )}
      {showRowTotal &&
        measureLabels.map((label, v) => (
          <td key={`rowtotal:${label}`} className="numeric matrix-total">
            {formatValue(rowTotal(node, v))}
          </td>
        ))}
    </>
  );

  // Siblings ordered within their own group, so a child never moves out
  // from under its parent -- sorting a matrix is not sorting a list.
  const sortValue = (node: RowNode): number | string => {
    if (!sort || sort.key === LABEL_KEY) return node.label;
    const split = sort.key.lastIndexOf(":");
    const colKey = sort.key.slice(0, split);
    const index = Number(sort.key.slice(split + 1));
    if (colKey === TOTAL_KEY) return rowTotal(node, index);
    // A group with no cell in this column sorts as if it had none, rather
    // than as if it had zero: absent and zero are different answers.
    return node.totals.has(colKey) ? node.totals.get(colKey)![index] : Number.NaN;
  };
  const sortedChildren = sort
    ? sortTree(root.children, sort.direction, sortValue)
    : root.children;

  // Flatten the tree depth-first, honouring collapse. Group rows render
  // their aggregates inline (stepped layout); leaves are just rows.
  const bodyRows: JSX.Element[] = [];
  const walk = (node: RowNode) => {
    const isLeaf = node.children.length === 0;
    const isCollapsed = collapsed.has(node.key);
    bodyRows.push(
      <tr key={node.key} className={isLeaf ? undefined : "matrix-group"}>
        <th scope="row" style={{ paddingLeft: `${8 + node.depth * 18}px` }}>
          {!isLeaf && (
            <button
              type="button"
              className="matrix-toggle"
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.label}`}
              onClick={() => toggle(node.key)}
            >
              {isCollapsed ? "+" : "−"}
            </button>
          )}
          {node.label}
        </th>
        {cellsFor(node)}
      </tr>,
    );
    if (!isCollapsed) node.children.forEach(walk);
  };
  sortedChildren.forEach(walk);

  const groupKeys = [...nodes.values()]
    .filter((n) => n.children.length > 0)
    .map((n) => n.key);
  const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsed.has(k));
  const allExpanded = collapsed.size === 0;

  return (
    <div className="matrix-scroll" ref={scroller}>
      {groupKeys.length > 0 && (
        <div className="matrix-toolbar" role="toolbar" aria-label="Matrix hierarchy">
          <button
            type="button"
            aria-label="Expand all"
            title="Expand all"
            disabled={allExpanded}
            onClick={() => setCollapsed(new Set())}
          >
            {"⊞"}
          </button>
          <button
            type="button"
            aria-label="Collapse all"
            title="Collapse all"
            disabled={allCollapsed}
            onClick={() => setCollapsed(new Set(groupKeys))}
          >
            {"⊟"}
          </button>
        </div>
      )}
      <table className="matrix">
        <thead>
          {colIdx >= 0 && (
            <tr className="matrix-head-groups" ref={groupRow}>
              <th scope="col" rowSpan={2}>
                {rowRefs.map(fieldName).join(" / ")}
              </th>
              {columnKeys.map((key) => (
                <th key={key} scope="col" colSpan={measureLabels.length}>
                  {key}
                </th>
              ))}
              {showRowTotal && (
                <th scope="col" colSpan={measureLabels.length} className="matrix-total">
                  Total
                </th>
              )}
            </tr>
          )}
          <tr className="matrix-head-labels">
            {colIdx < 0 && (
              <th scope="col" aria-sort={ariaSort(LABEL_KEY)}>
                <button
                  type="button"
                  className="th-sort"
                  onClick={() => toggleSort(LABEL_KEY)}
                >
                  {rowRefs.map(fieldName).join(" / ")}
                  <span className="th-sort-arrow" aria-hidden="true">
                    {arrow(LABEL_KEY)}
                  </span>
                </button>
              </th>
            )}
            {headerColumns.map((key) =>
              measureLabels.map((label, index) => (
                <th
                  key={`${key}:${label}`}
                  scope="col"
                  className="numeric"
                  aria-sort={ariaSort(`${key}:${index}`)}
                >
                  <button
                    type="button"
                    className="th-sort th-sort-numeric"
                    onClick={() => toggleSort(`${key}:${index}`)}
                  >
                    {label}
                    <span className="th-sort-arrow" aria-hidden="true">
                      {arrow(`${key}:${index}`)}
                    </span>
                  </button>
                </th>
              )),
            )}
            {showRowTotal &&
              measureLabels.map((label, index) => (
                <th
                  key={`total:${label}`}
                  scope="col"
                  className="numeric matrix-total"
                  aria-sort={ariaSort(`${TOTAL_KEY}:${index}`)}
                >
                  <button
                    type="button"
                    className="th-sort th-sort-numeric"
                    onClick={() => toggleSort(`${TOTAL_KEY}:${index}`)}
                  >
                    {label}
                    <span className="th-sort-arrow" aria-hidden="true">
                      {arrow(`${TOTAL_KEY}:${index}`)}
                    </span>
                  </button>
                </th>
              ))}
          </tr>
        </thead>
        <tbody>{bodyRows}</tbody>
        {showTotals && (
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {cellsFor(root)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
