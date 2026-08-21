import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { CompositeDefinition } from "../api/composites";
import type { Relationship } from "../api/types";
import type { CompositeViewDetail, MemberGraph } from "../models/availability";
import { MANY, NODE_WIDTH, ONE, ROW_HEIGHT } from "../model/graph";
import { colourOf, paletteFor, type ViewColour } from "./palette";

/**
 * A composite model as a React Flow graph: member views as backdrops,
 * their tables inside them, conformed dimensions drawn between columns.
 *
 * Pure — no React, no DOM, no measurement — for the same reason
 * `model/graph.ts` is: a layout you can assert in a test is one you do
 * not have to eyeball in a browser.
 *
 * The rule that shapes everything here: **both collapse states show
 * relationships, and they differ in precision rather than presence.**
 * Collapsed, a backdrop still lists the columns that take part in a
 * conformed dimension, so every edge has somewhere to land. Expanded, the
 * view's tables appear and each edge re-anchors to the real column on the
 * real card — along with the view's own internal joins, which is most of
 * why anybody expands one.
 */

export const BACKDROP_HEADER = 34;
export const BACKDROP_PADDING = 14;
/** A conformed column listed on a collapsed backdrop. */
export const SUMMARY_ROW = 22;
const TABLE_HEADER = 34;
const GAP = 56;

export interface BackdropData extends Record<string, unknown> {
  alias: string;
  view: string;
  colour: ViewColour;
  expanded: boolean;
  tableCount: number;
  /** False when this member has no describe. The container then says so
   *  instead of rendering as an empty box, which is indistinguishable
   *  from a bug. */
  readable: boolean;
  /** What the warehouse actually said, when it said anything. Reported
   *  verbatim rather than paraphrased: guessing "your role cannot see
   *  it" was wrong once already, and sent somebody looking at grants
   *  when the fault was ours. */
  problem: string | null;
  /** Shown when collapsed: the columns this view contributes to a
   *  conformed dimension, in the model's order, each an edge anchor. */
  summary: { dimension: string; table: string; column: string }[];
}

export interface DesignerTableData extends Record<string, unknown> {
  alias: string;
  table: string;
  colour: ViewColour;
  columns: { name: string; conformed: string | null }[];
}

export type BackdropNode = Node<BackdropData, "backdrop">;
export type DesignerTableNode = Node<DesignerTableData, "designerTable">;
export type DesignerNode = BackdropNode | DesignerTableNode;

export interface DesignerEdgeData extends Record<string, unknown> {
  /** "conformed" is the model's and editable; "internal" is the view's
   *  own and is not — the canvas says so rather than merely not
   *  responding. */
  kind: "conformed" | "internal" | "ghost";
  /** Which shared dimension, for the conformed kind. */
  dimension?: string;
  dimensionIndex?: number;
  /** For a ghost: why it is being suggested. */
  reason?: string;
  label?: string;
}

export type DesignerEdge = Edge<DesignerEdgeData>;

/** `ORDERS.REVENUE` -> `ORDERS`. */
function tableOf(name: string): string {
  return name.split(".", 1)[0];
}

/** The handle a column is anchored by, on a table card or a backdrop
 *  summary row. One format, so the node components and the edge builder
 *  cannot drift apart. */
export function columnHandle(alias: string, table: string, column: string): string {
  return `${alias}::${table}.${column}`;
}

/** `source:sales::CUSTOMER.CUSTOMER_ID` -> the column it names.
 *
 *  The inverse of `columnHandle`, kept beside it: a drag arrives as two
 *  handle ids and nothing else, so if these two ever disagreed a drop
 *  would resolve to the wrong column rather than failing. */
export function parseHandle(
  handle: string | null | undefined,
): { alias: string; table: string; column: string } | null {
  if (!handle) return null;
  const withoutRole = handle.replace(/^(source|target):/, "");
  const [alias, rest] = withoutRole.split("::");
  if (!alias || !rest) return null;
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { alias, table: rest.slice(0, dot), column: rest.slice(dot + 1) };
}

/** The columns a view actually contributes, grouped by its own table. */
function columnsByTable(
  detail: CompositeViewDetail,
  alias: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string) => {
    const table = tableOf(name);
    const column = name.slice(table.length + 1);
    if (!table || !column) return;
    const list = out.get(table) ?? [];
    if (!list.includes(column)) list.push(column);
    out.set(table, list);
  };
  for (const field of [...(detail.dimensions ?? []), ...(detail.metrics ?? [])]) {
    if ((field.table ?? "").toLowerCase() !== alias.toLowerCase()) continue;
    add(field.name);
  }
  return out;
}

/** Tables of a member: every one its graph declares, plus any the field
 *  list mentions. A table with no exposed field still matters — it can be
 *  the one a join passes through. */
function tablesOf(graph: MemberGraph | undefined, fields: Map<string, string[]>): string[] {
  const names = new Set<string>();
  for (const table of graph?.tables ?? []) if (table?.name) names.add(table.name);
  for (const table of fields.keys()) names.add(table);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function tableHeight(columns: number): number {
  return TABLE_HEADER + Math.max(columns, 1) * ROW_HEIGHT + 8;
}

/** Lay a member's tables out inside its backdrop, and report the size the
 *  backdrop has to be to hold them. */
function layoutInside(
  tables: string[],
  heights: Map<string, number>,
  relationships: Relationship[],
): { at: Map<string, { x: number; y: number }>; width: number; height: number } {
  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: 48, nodesep: 24, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const table of tables) {
    graph.setNode(table, { width: NODE_WIDTH, height: heights.get(table) ?? tableHeight(1) });
  }
  const present = new Set(tables);
  for (const relationship of relationships) {
    if (!relationship.table || !relationship.refTable) continue;
    if (!present.has(relationship.table) || !present.has(relationship.refTable)) continue;
    graph.setEdge(relationship.table, relationship.refTable, {}, relationship.name);
  }
  dagreLayout(graph);

  const at = new Map<string, { x: number; y: number }>();
  for (const table of tables) {
    const node = graph.node(table) as { x: number; y: number; width: number; height: number };
    // dagre reports centres; React Flow positions children by their
    // top-left corner, relative to the parent.
    at.set(table, {
      x: node.x - node.width / 2 + BACKDROP_PADDING,
      y: node.y - node.height / 2 + BACKDROP_HEADER,
    });
  }
  const size = graph.graph() as { width?: number; height?: number };
  return {
    at,
    width: (size.width ?? NODE_WIDTH) + BACKDROP_PADDING * 2,
    height: (size.height ?? tableHeight(1)) + BACKDROP_HEADER + BACKDROP_PADDING,
  };
}

export interface GhostEdge {
  name: string;
  reason: string;
  bindings: Record<string, { table: string; column: string }>;
}

/**
 * Nodes and edges for the whole model.
 *
 * `expanded` names the members showing their tables. `ghosts` are
 * suggested mappings from the matcher, drawn dashed until somebody
 * accepts one — they are never applied here, because a mapping the app
 * made is one nobody reviewed.
 */
export function buildDesigner(
  definition: CompositeDefinition,
  detail: CompositeViewDetail,
  expanded: ReadonlySet<string> = new Set(),
  ghosts: GhostEdge[] = [],
): { nodes: DesignerNode[]; edges: DesignerEdge[] } {
  const palette = paletteFor(definition.members.map((m) => m.alias));
  const graphs = new Map(
    (detail.memberGraphs ?? []).map((graph) => [graph.alias.toLowerCase(), graph]),
  );

  // Which of a member's columns are conformed, and to what.
  const conformed = new Map<string, string>();
  definition.sharedDimensions.forEach((shared) => {
    for (const [alias, binding] of Object.entries(shared.bindings)) {
      conformed.set(
        columnHandle(alias.toLowerCase(), binding.table, binding.column),
        shared.name,
      );
    }
  });

  const nodes: DesignerNode[] = [];
  const edges: DesignerEdge[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  const children: DesignerTableNode[] = [];

  for (const member of definition.members) {
    const alias = member.alias;
    const key = alias.toLowerCase();
    const isOpen = expanded.has(key);
    const fields = columnsByTable(detail, alias);
    const graph = graphs.get(key);
    const tables = tablesOf(graph, fields);

    const summary = definition.sharedDimensions
      .map((shared) => {
        const entry = Object.entries(shared.bindings).find(
          ([bound]) => bound.toLowerCase() === key,
        );
        return entry
          ? { dimension: shared.name, table: entry[1].table, column: entry[1].column }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (!isOpen) {
      sizes.set(key, {
        width: NODE_WIDTH,
        height:
          BACKDROP_HEADER +
          Math.max(summary.length, 1) * SUMMARY_ROW +
          BACKDROP_PADDING,
      });
    } else {
      const heights = new Map(
        tables.map((table) => [table, tableHeight((fields.get(table) ?? []).length)]),
      );
      const inside = layoutInside(tables, heights, graph?.relationships ?? []);
      sizes.set(key, { width: inside.width, height: inside.height });
      for (const table of tables) {
        const at = inside.at.get(table)!;
        children.push({
          id: `${key}/${table}`,
          type: "designerTable",
          parentId: key,
          extent: "parent",
          position: at,
          width: NODE_WIDTH,
          height: heights.get(table),
          data: {
            alias,
            table,
            colour: colourOf(palette, alias),
            columns: (fields.get(table) ?? []).map((column) => ({
              name: column,
              conformed: conformed.get(columnHandle(key, table, column)) ?? null,
            })),
          },
        });
      }
      // The view's own joins, visible exactly when its tables are.
      for (const relationship of graph?.relationships ?? []) {
        if (!relationship.table || !relationship.refTable) continue;
        if (!tables.includes(relationship.table)) continue;
        if (!tables.includes(relationship.refTable)) continue;
        edges.push({
          id: `internal:${key}:${relationship.name}`,
          source: `${key}/${relationship.table}`,
          target: `${key}/${relationship.refTable}`,
          markerStart: MANY,
          markerEnd: ONE,
          className: "designer-edge-internal",
          data: {
            kind: "internal",
            label: (relationship.foreignKey ?? []).join(", ") || undefined,
          },
        });
      }
    }

    nodes.push({
      id: key,
      type: "backdrop",
      position: { x: 0, y: 0 },
      width: sizes.get(key)!.width,
      height: sizes.get(key)!.height,
      // A backdrop is scenery for its tables; selecting it instead of
      // them would make clicking a card select the view.
      selectable: false,
      data: {
        alias,
        view: `${member.database}.${member.schema}.${member.view}`,
        colour: colourOf(palette, alias),
        expanded: isOpen,
        tableCount: tables.length,
        readable: Boolean(graph) || tables.length > 0,
        problem: (detail.memberErrors ?? {})[key] ?? null,
        summary,
      },
    });
  }

  // --- lay the backdrops out, related by their conformed dimensions ---
  const outer = new Graph({ multigraph: true });
  outer.setGraph({ rankdir: "LR", ranksep: GAP * 2, nodesep: GAP, marginx: 24, marginy: 24 });
  outer.setDefaultEdgeLabel(() => ({}));
  for (const [key, size] of sizes) outer.setNode(key, { ...size });
  definition.sharedDimensions.forEach((shared, index) => {
    const bound = Object.keys(shared.bindings).map((a) => a.toLowerCase());
    for (let i = 0; i + 1 < bound.length; i += 1) {
      if (!sizes.has(bound[i]) || !sizes.has(bound[i + 1])) continue;
      outer.setEdge(bound[i], bound[i + 1], {}, `${shared.name}:${index}:${i}`);
    }
  });
  dagreLayout(outer);

  for (const node of nodes) {
    const placed = outer.node(node.id) as { x: number; y: number; width: number; height: number };
    node.position = {
      x: placed.x - placed.width / 2,
      y: placed.y - placed.height / 2,
    };
  }
  nodes.push(...children);

  // --- the conformed edges -------------------------------------------
  const anchor = (alias: string, table: string, column: string) => {
    const key = alias.toLowerCase();
    return expanded.has(key)
      ? { node: `${key}/${table}`, handle: columnHandle(key, table, column) }
      : { node: key, handle: columnHandle(key, table, column) };
  };

  definition.sharedDimensions.forEach((shared, index) => {
    const bound = Object.entries(shared.bindings);
    // Drawn as a chain rather than every pair: a three-way dimension is
    // one concept, and three crossing lines say "three mappings".
    for (let i = 0; i + 1 < bound.length; i += 1) {
      const [fromAlias, from] = bound[i];
      const [toAlias, to] = bound[i + 1];
      if (!sizes.has(fromAlias.toLowerCase())) continue;
      if (!sizes.has(toAlias.toLowerCase())) continue;
      const a = anchor(fromAlias, from.table, from.column);
      const b = anchor(toAlias, to.table, to.column);
      edges.push({
        id: `conformed:${index}:${i}`,
        source: a.node,
        sourceHandle: `source:${a.handle}`,
        target: b.node,
        targetHandle: `target:${b.handle}`,
        className: "designer-edge-conformed",
        data: {
          kind: "conformed",
          dimension: shared.name,
          dimensionIndex: index,
          label: shared.name,
        },
      });
    }
  });

  // --- suggestions ----------------------------------------------------
  ghosts.forEach((ghost, index) => {
    const bound = Object.entries(ghost.bindings);
    for (let i = 0; i + 1 < bound.length; i += 1) {
      const [fromAlias, from] = bound[i];
      const [toAlias, to] = bound[i + 1];
      if (!sizes.has(fromAlias.toLowerCase())) continue;
      if (!sizes.has(toAlias.toLowerCase())) continue;
      const a = anchor(fromAlias, from.table, from.column);
      const b = anchor(toAlias, to.table, to.column);
      edges.push({
        id: `ghost:${index}:${i}`,
        source: a.node,
        sourceHandle: `source:${a.handle}`,
        target: b.node,
        targetHandle: `target:${b.handle}`,
        className: "designer-edge-ghost",
        data: { kind: "ghost", dimension: ghost.name, reason: ghost.reason, label: ghost.name },
      });
    }
  });

  return { nodes, edges };
}
