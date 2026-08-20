import type { Relationship, SemanticViewDetail } from "../api/types";

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
const GAP_X = 90;
const GAP_Y = 28;
const PADDING = 16;

export interface ModelNode {
  name: string;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldCount: number;
  /** A table that points at another sits at finer grain, which is what
   *  makes it fact-like; one nothing points out of is a leaf dimension.
   *  Colour follows this, so the grain of the model is readable at a
   *  glance rather than inferred from arrow directions. */
  kind: "fact" | "dimension";
}

export interface ModelEdge {
  name: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ModelLayout {
  nodes: ModelNode[];
  edges: ModelEdge[];
  width: number;
  height: number;
}

/** Relationships whose two ends are both tables in this model.
 *
 *  `table` and `refTable` are nullable in the describe payload, and a
 *  dangling end would otherwise place an edge pointing at a node that was
 *  never drawn. */
function realEdges(detail: SemanticViewDetail): Relationship[] {
  const names = new Set(detail.tables.map((t) => t.name));
  return detail.relationships.filter(
    (r) => r.table && r.refTable && names.has(r.table) && names.has(r.refTable),
  );
}

/**
 * How far this table is from one that points at nothing.
 *
 * Depth-capped and guarded by an in-progress set: a model that declares a
 * cycle must still place every table exactly once rather than running
 * until the stack gives out.
 */
function depthOf(
  table: string,
  outgoing: Map<string, string[]>,
  cache: Map<string, number>,
  limit: number,
): number {
  const inProgress = new Set<string>();
  const walk = (name: string, depth: number): number => {
    const known = cache.get(name);
    if (known !== undefined) return known;
    if (depth > limit || inProgress.has(name)) return 0;
    inProgress.add(name);
    const next = outgoing.get(name) ?? [];
    const result =
      next.length === 0
        ? 0
        : Math.max(...next.map((target) => walk(target, depth + 1) + 1));
    inProgress.delete(name);
    cache.set(name, result);
    return result;
  };
  return walk(table, 0);
}

/**
 * Where each table and join sits, by longest-path layering.
 *
 * A table sits one layer before the furthest table it points at, so every
 * arrow runs left to right and the join direction is readable at a glance.
 * Deterministic throughout -- tables are ordered by name within a layer --
 * because a diagram that rearranges itself when nothing changed reads as
 * unreliable rather than as informative.
 */
export function layoutModel(detail: SemanticViewDetail): ModelLayout {
  const tables = detail.tables.map((t) => t.name);
  if (tables.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const edges = realEdges(detail);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.table as string) ?? [];
    list.push(edge.refTable as string);
    outgoing.set(edge.table as string, list);
  }

  const fieldCounts = new Map<string, number>();
  for (const field of [...detail.dimensions, ...detail.metrics, ...detail.facts]) {
    fieldCounts.set(field.table, (fieldCounts.get(field.table) ?? 0) + 1);
  }

  const cache = new Map<string, number>();
  const depth = new Map(
    tables.map((t) => [t, depthOf(t, outgoing, cache, tables.length)]),
  );
  const deepest = Math.max(...depth.values());

  const byLayer = new Map<number, string[]>();
  for (const table of [...tables].sort((a, b) => a.localeCompare(b))) {
    const layer = deepest - (depth.get(table) ?? 0);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), table]);
  }

  const nodes: ModelNode[] = [];
  for (const [layer, names] of byLayer) {
    names.forEach((name, row) => {
      nodes.push({
        name,
        layer,
        x: PADDING + layer * (NODE_WIDTH + GAP_X),
        y: PADDING + row * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        fieldCount: fieldCounts.get(name) ?? 0,
        kind: (outgoing.get(name) ?? []).length > 0 ? "fact" : "dimension",
      });
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));

  const at = new Map(nodes.map((n) => [n.name, n]));
  const positioned: ModelEdge[] = edges.flatMap((edge) => {
    const from = at.get(edge.table as string);
    const to = at.get(edge.refTable as string);
    if (!from || !to) return [];
    return [
      {
        name: edge.name,
        from: from.name,
        to: to.name,
        x1: from.x + from.width,
        y1: from.y + from.height / 2,
        x2: to.x,
        y2: to.y + to.height / 2,
      },
    ];
  });

  return {
    nodes,
    edges: positioned,
    width: Math.max(...nodes.map((n) => n.x + n.width)) + PADDING,
    height: Math.max(...nodes.map((n) => n.y + n.height)) + PADDING,
  };
}
