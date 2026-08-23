/** The semantic view as a React Flow graph, laid out by dagre.
 *
 *  Pure: no React, no DOM, no measurement. That is what lets the layout
 *  be asserted in a test rather than eyeballed in a browser, and it is
 *  why the hand-rolled force simulation this replaced is gone -- dagre
 *  is deterministic for a given insertion order, and everything below
 *  is inserted in name order.
 */

import { Graph, layout } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { FieldInfo, Relationship, SemanticViewDetail } from "../api/types";

export const NODE_WIDTH = 280;
/** Table name, kind badge, field count. */
export const NODE_HEADER = 40;
/** One column row. */
export const ROW_HEIGHT = 26;
/** Rows a card shows before it offers to expand. Join keys are never
 *  counted against this: an edge anchors to its key row, so a hidden key
 *  would leave the edge with nothing to attach to.
 *
 *  Deliberately small. Every extra row is height the whole diagram has to
 *  be scaled down by to fit, and a card is meant to say what a table IS,
 *  not to be its field list -- the panel on the right is that. */
export const PREVIEW_ROWS = 6;
/** The "+N more" row. */
export const MORE_HEIGHT = 22;
/** Space between ranks, and between cards within a rank. */
const RANK_SEP = 110;
const NODE_SEP = 30;
/** A stand-in for the pane, used only to compare two candidate layouts.
 *  Its absolute size does not matter -- scaling it scales both candidates'
 *  fit equally -- so what this really says is "the pane is landscape". */
const REFERENCE_PANE = { width: 1600, height: 900 };
/** How much bigger top-to-bottom has to come out before it is worth
 *  leaving the left-to-right convention for. */
const TURN_THRESHOLD = 1.15;

export interface ModelColumn {
  name: string;
  dataType: string | null;
  kind: "key" | "dimension" | "metric" | "fact";
  /** `TABLE.NAME` for a modelled field. Null for a physical join key,
   *  which names a column in the underlying table rather than a field of
   *  the semantic view -- so it cannot be put in a query and must not be
   *  offered as though it could. */
  ref: string | null;
}

export interface TableNodeData extends Record<string, unknown> {
  table: string;
  /** A table that references another sits at finer grain, which is what
   *  makes it fact-like; one that references nothing is a leaf dimension. */
  kind: "fact" | "dimension";
  columns: ModelColumn[];
  /** Fields not shown, because the card is collapsed. */
  hidden: number;
  fieldCount: number;
  expanded: boolean;
}

export type TableNode = Node<TableNodeData, "table">;

export interface ModelEdgeData extends Record<string, unknown> {
  /** "O_CUSTKEY = C_CUSTKEY", or null when the describe carried no keys. */
  on: string | null;
  from: string;
  to: string;
}

export type ModelEdge = Edge<ModelEdgeData>;

export type Side = "left" | "right" | "top" | "bottom";

/** Crow's-foot marker ids, defined once in ModelDiagram's <defs>. */
export const MANY = "model-many";
export const ONE = "model-one";

/** Both ends of a handle id, so the node component and the edge builder
 *  cannot drift apart on the format. */
export function handleId(
  type: "source" | "target",
  side: Side,
  column: string,
): string {
  return `${type}:${side}:${column}`;
}

/** Relationships with both ends present in this model.
 *
 *  `table` and `refTable` are nullable in the describe payload, and a
 *  dangling end would anchor an edge to a node that is never drawn. */
export function realEdges(detail: SemanticViewDetail): Relationship[] {
  const names = new Set((detail.tables ?? []).map((t) => t.name));
  return (detail.relationships ?? [])
    .filter((r) => r.table && r.refTable && names.has(r.table) && names.has(r.refTable))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The physical join keys each table carries, as columns in their own right.
 *
 *  FOREIGN_KEY and REF_KEY name physical columns while a semantic view's
 *  dimensions and metrics are modelled fields over expressions, so
 *  O_CUSTKEY is essentially never one of them. Matching the two by name
 *  left every card keyless; listing the keys separately is what an ER
 *  diagram shows anyway. */
function keyColumns(edges: Relationship[]): Map<string, ModelColumn[]> {
  const byTable = new Map<string, ModelColumn[]>();
  const add = (table: string | null | undefined, name: string) => {
    if (!table || !name) return;
    const columns = byTable.get(table) ?? [];
    if (columns.some((c) => c.name.toUpperCase() === name.toUpperCase())) return;
    byTable.set(table, [...columns, { name, dataType: null, kind: "key", ref: null }]);
  };
  for (const edge of edges) {
    for (const column of edge.foreignKey ?? []) add(edge.table, column);
    for (const column of edge.refKey ?? []) add(edge.refTable, column);
  }
  // By name, not by the order the relationships happened to be visited in:
  // a table on two joins would otherwise list its keys in an order that
  // depends on what the OTHER tables are called.
  for (const [table, columns] of byTable) {
    byTable.set(table, [...columns].sort((a, b) => a.name.localeCompare(b.name)));
  }
  return byTable;
}

/** Every column of every table, keys first. */
export function columnsByTable(detail: SemanticViewDetail): Map<string, ModelColumn[]> {
  const byTable = keyColumns(realEdges(detail));
  const collect = (fields: FieldInfo[] | undefined, kind: ModelColumn["kind"]) => {
    for (const field of fields ?? []) {
      byTable.set(field.table, [
        ...(byTable.get(field.table) ?? []),
        {
          name: field.name,
          dataType: field.dataType,
          kind,
          ref: `${field.table}.${field.name}`,
        },
      ]);
    }
  };
  collect(detail.dimensions, "dimension");
  collect(detail.metrics, "metric");
  collect(detail.facts, "fact");
  for (const table of detail.tables ?? []) {
    if (!byTable.has(table.name)) byTable.set(table.name, []);
  }
  return byTable;
}

/** What a card actually draws: every key, then fields up to the cap. */
function visibleColumns(all: ModelColumn[], expanded: boolean): ModelColumn[] {
  if (expanded) return all;
  const keys = all.filter((c) => c.kind === "key");
  const fields = all.filter((c) => c.kind !== "key").slice(0, PREVIEW_ROWS);
  return [...keys, ...fields];
}

export function nodeHeight(rows: number, more: boolean): number {
  return NODE_HEADER + rows * ROW_HEIGHT + (more ? MORE_HEIGHT : 0) + 8;
}

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Run dagre once, in one direction. */
function place(
  rankdir: "LR" | "TB",
  sizes: Map<string, { width: number; height: number }>,
  relationships: Relationship[],
): { at: Map<string, Placed>; width: number; height: number } {
  const graph = new Graph({ multigraph: true });
  graph.setGraph({
    rankdir,
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    marginx: 24,
    marginy: 24,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const [table, size] of sizes) graph.setNode(table, { ...size });
  for (const relationship of relationships) {
    graph.setEdge(
      relationship.table as string,
      relationship.refTable as string,
      {},
      relationship.name,
    );
  }
  layout(graph);

  const at = new Map<string, Placed>();
  for (const table of sizes.keys()) at.set(table, graph.node(table) as Placed);
  const size = graph.graph() as { width?: number; height?: number };
  return { at, width: size.width ?? 1, height: size.height ?? 1 };
}

/** What fit-to-screen would scale this layout by. The question is not
 *  which shape is prettier but which one shows up bigger, and those are
 *  different: a layout closer to the pane's aspect ratio can still be the
 *  smaller of the two once both are actually fitted. */
function fitScale(width: number, height: number): number {
  return Math.min(
    REFERENCE_PANE.width / Math.max(width, 1),
    REFERENCE_PANE.height / Math.max(height, 1),
  );
}

/**
 * Nodes and edges, positioned.
 *
 * Laid out twice and the better one kept. Left-to-right is the ER
 * convention and it keeps a join edge anchored to the key ROW it is
 * declared on -- but a star schema in LR puts every dimension in one
 * vertical rank, which on a landscape pane is a tall thin ribbon that has
 * to be scaled to nothing before it fits. Top-to-bottom spreads that same
 * rank across the width. Which of the two wins depends on the model, so
 * the model decides.
 *
 * `expanded` names the tables showing all of their fields. Expanding one
 * changes its height, so the whole graph is laid out again -- cheap at
 * this size, and it keeps cards from overlapping the moment one grows.
 */
export function buildGraph(
  detail: SemanticViewDetail,
  expanded: ReadonlySet<string> = new Set(),
): { nodes: TableNode[]; edges: ModelEdge[] } {
  const tables = [...(detail.tables ?? []).map((t) => t.name)].sort((a, b) =>
    a.localeCompare(b),
  );
  if (tables.length === 0) return { nodes: [], edges: [] };

  const relationships = realEdges(detail);
  const columns = columnsByTable(detail);
  const references = new Set(relationships.map((r) => r.table as string));

  const data = new Map<string, TableNodeData>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const table of tables) {
    const all = columns.get(table) ?? [];
    const shown = visibleColumns(all, expanded.has(table));
    const hidden = all.length - shown.length;
    data.set(table, {
      table,
      kind: references.has(table) ? "fact" : "dimension",
      columns: shown,
      hidden,
      fieldCount: all.filter((c) => c.kind !== "key").length,
      expanded: expanded.has(table),
    });
    sizes.set(table, {
      width: NODE_WIDTH,
      height: nodeHeight(shown.length, hidden > 0),
    });
  }

  const wide = place("LR", sizes, relationships);
  const tall = place("TB", sizes, relationships);
  // Left-to-right is the default and has to be BEATEN, not merely tied:
  // it is the ER convention, and it is the orientation that anchors edges
  // to key rows. A few percent is noise -- what it would buy in scale it
  // would lose by turning the same model sideways between one view and
  // the next.
  const chosen =
    fitScale(tall.width, tall.height) >
    fitScale(wide.width, wide.height) * TURN_THRESHOLD
      ? tall
      : wide;

  const nodes: TableNode[] = tables.map((table) => {
    const placed = chosen.at.get(table) as Placed;
    return {
      id: table,
      type: "table" as const,
      // dagre reports centres; React Flow positions by top-left corner.
      position: { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 },
      data: data.get(table) as TableNodeData,
      // Measured sizes would arrive a frame later and make the first
      // fitView frame wrong; these are the sizes dagre was given.
      width: placed.width,
      height: placed.height,
    };
  });

  const edges: ModelEdge[] = relationships.map((relationship) => {
    const from = relationship.table as string;
    const to = relationship.refTable as string;
    const a = chosen.at.get(from) as Placed;
    const b = chosen.at.get(to) as Placed;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const foreign = relationship.foreignKey?.[0] ?? "";
    const referenced = relationship.refKey?.[0] ?? "";

    // Which side of each card the line leaves and arrives at. A line that
    // enters the side it should have left from loops back over its own
    // card, so the sides follow the separation rather than the rank
    // direction -- a back edge runs the other way in either layout.
    //
    // Sideways it anchors to the key ROW, which is the point of the whole
    // arrangement. Vertically it cannot: a row is 26px tall and the width
    // of the card, so its top edge is the card's top edge. It anchors to
    // the card instead, and says so by using the card's own handle.
    let sourceSide: Side;
    let targetSide: Side;
    let sourceColumn = foreign;
    let targetColumn = referenced;
    if (Math.abs(dx) >= Math.abs(dy)) {
      sourceSide = dx >= 0 ? "right" : "left";
      targetSide = dx >= 0 ? "left" : "right";
    } else {
      sourceSide = dy >= 0 ? "bottom" : "top";
      targetSide = dy >= 0 ? "top" : "bottom";
      sourceColumn = "";
      targetColumn = "";
    }

    const on =
      relationship.foreignKey?.length && relationship.refKey?.length
        ? `${relationship.foreignKey.join(", ")} = ${relationship.refKey.join(", ")}`
        : null;
    return {
      id: relationship.name,
      source: from,
      target: to,
      sourceHandle: handleId("source", sourceSide, sourceColumn),
      targetHandle: handleId("target", targetSide, targetColumn),
      type: "smoothstep",
      // Crow's foot: many at the foreign key, one at the referenced key.
      // A semantic view's relationship is many-to-one by construction --
      // it declares a foreign key against a referenced key -- and
      // Snowflake reports no cardinality of its own, so one-to-one is
      // never claimed.
      // The bare id, not a url(): React Flow wraps a string marker itself
      // as url('#<id>'), so passing the url() form produced
      // url('#url(#model-many)') and no marker rendered at all.
      markerStart: MANY,
      markerEnd: ONE,
      data: { on, from, to },
    };
  });

  return { nodes, edges };
}
