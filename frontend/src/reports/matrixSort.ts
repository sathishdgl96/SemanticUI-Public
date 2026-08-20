import type { SortDirection } from "../query/sortRows";

/** The shape sorting needs: a label, children, and whatever the caller
 *  reads a sort value out of. Deliberately structural rather than the
 *  matrix's own RowNode, so the sort can be tested without building a
 *  result set to hang it on. */
export interface SortableNode {
  label: string;
  children: SortableNode[];
}

/**
 * Siblings in sort order, at every level.
 *
 * A matrix is a hierarchy, so sorting it is not sorting a list: each
 * group's children are ordered WITHIN that group, and a child never
 * moves out from under its parent. Flattening and sorting the whole
 * thing would put France beside Japan and lose the shape that makes a
 * matrix worth drawing.
 *
 * Never mutates: the tree is rebuilt, because the caller's copy is
 * derived from the query result and is reused when the sort is cleared.
 */
export function sortTree<T extends SortableNode>(
  nodes: T[],
  direction: SortDirection | null,
  valueOf: (node: T) => number | string,
): T[] {
  if (!direction) return nodes;
  const sign = direction === "asc" ? 1 : -1;

  return nodes
    .map((node, position) => ({ node, position }))
    .sort((a, b) => {
      const left = valueOf(a.node);
      const right = valueOf(b.node);
      let order: number;
      if (typeof left === "number" && typeof right === "number") {
        order = left - right;
      } else {
        order = String(left).localeCompare(String(right), undefined, {
          sensitivity: "base",
          numeric: true,
        });
      }
      // Stable: equal values keep the order the query produced, which is
      // the semantic layer's own.
      return order !== 0 ? order * sign : a.position - b.position;
    })
    .map((entry) => ({
      ...entry.node,
      children: sortTree(entry.node.children as T[], direction, valueOf),
    }));
}
