import type { FieldInfo, Relationship, SemanticViewDetail } from "../api/types";

export const NODE_WIDTH = 268;
/** Header only, for a table whose columns are all hidden. */
export const NODE_HEADER = 40;
/** One column row inside a card. */
export const ROW_HEIGHT = 23;
/** Columns shown before the card says how many more there are. Enough to
 *  recognise a table by; past that the card starts competing with the
 *  diagram for the reader's attention. */
export const MAX_ROWS = 8;
/** Kept for callers that only need a representative size. */
export const NODE_HEIGHT = NODE_HEADER + MAX_ROWS * ROW_HEIGHT;
const PADDING = 40;
/** How far apart consecutive rings sit. */
const RING_GAP = 190;
/** Rings are very slightly elliptical, to lean into a landscape pane
 *  without distorting the shape of the model. */
const ASPECT = 1.15;
/** Clearance between two boxes sitting side by side on the same ring. */
const NODE_CLEARANCE = 70;
/** A lone child continues straight out along its parent's direction.
 *  Curving it seemed tidier and was not: the chain then swept across
 *  the other branches instead of away from them. */
const CHAIN_DRIFT = 0;
/** How far siblings fan either side of their parent's direction. */
const SIBLING_SPREAD = 0.5;

export interface ModelNode {
  name: string;
  /** How many joins from the hub. 0 is the hub itself. */
  ring: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldCount: number;
  /** The columns to draw inside the card, already capped at MAX_ROWS. */
  columns: ModelColumn[];
  /** How many columns did not fit. Zero when they all did. */
  hiddenColumns: number;
  /** A table that points at another sits at finer grain, which is what
   *  makes it fact-like; one nothing points out of is a leaf dimension.
   *  Colour follows this, so the grain of the model reads at a glance. */
  kind: "fact" | "dimension";
}

export interface ModelColumn {
  name: string;
  dataType: string | null;
  kind: "key" | "dimension" | "metric" | "fact";
  /** Part of a declared join. Marked, because the keys are what the
   *  relationships in the diagram are actually drawn on. */
  key: boolean;
}

/** The join keys a table carries, as their own rows.
 *
 *  FOREIGN_KEY and REF_KEY name PHYSICAL columns, while a semantic
 *  view's dimensions and metrics are modelled fields over expressions --
 *  so O_CUSTKEY is essentially never one of them, and marking matching
 *  field names left every card keyless. The keys are listed in their own
 *  right instead, which is what an ER diagram shows anyway.
 */
function keyColumnsOf(edges: Relationship[]): Map<string, ModelColumn[]> {
  const byTable = new Map<string, ModelColumn[]>();
  const add = (table: string | null, name: string) => {
    if (!table || !name) return;
    const existing = byTable.get(table) ?? [];
    if (existing.some((c) => c.name.toUpperCase() === name.toUpperCase())) return;
    byTable.set(table, [
      ...existing,
      { name, dataType: null, kind: "key", key: true },
    ]);
  };
  for (const edge of edges) {
    for (const column of edge.foreignKey ?? []) add(edge.table, column);
    for (const column of edge.refKey ?? []) add(edge.refTable, column);
  }
  return byTable;
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
 *  dangling end would otherwise anchor an edge to a node never drawn. */
function realEdges(detail: SemanticViewDetail): Relationship[] {
  const names = new Set(detail.tables.map((t) => t.name));
  return detail.relationships.filter(
    (r) => r.table && r.refTable && names.has(r.table) && names.has(r.refTable),
  );
}

/**
 * The table everything else hangs off: the most connected one.
 *
 * In the star schemas semantic views almost always describe, that is the
 * fact table, and putting it in the middle is what turns a long thin
 * chain into a shape that uses the screen. Ties break alphabetically so
 * the same model always produces the same diagram.
 */
function hubOf(tables: string[], edges: Relationship[]): string {
  const degree = new Map(tables.map((t) => [t, 0]));
  for (const edge of edges) {
    degree.set(edge.table as string, (degree.get(edge.table as string) ?? 0) + 1);
    degree.set(edge.refTable as string, (degree.get(edge.refTable as string) ?? 0) + 1);
  }
  return [...tables].sort((a, b) => {
    const byDegree = (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
    return byDegree !== 0 ? byDegree : a.localeCompare(b);
  })[0];
}

/**
 * How many joins each table sits from the hub, ignoring join direction.
 *
 * Direction decides what is answerable; distance decides what is near,
 * and for placement it is nearness that matters. Tables with no path to
 * the hub land one ring beyond the furthest that has one, rather than
 * being dropped.
 */
function ringsFrom(
  hub: string,
  tables: string[],
  edges: Relationship[],
): { ring: Map<string, number>; parents: Map<string, string> } {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) =>
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
  for (const edge of edges) {
    link(edge.table as string, edge.refTable as string);
    link(edge.refTable as string, edge.table as string);
  }

  const ring = new Map<string, number>([[hub, 0]]);
  const parents = new Map<string, string>();
  let frontier = [hub];
  while (frontier.length > 0) {
    const next: string[] = [];
    // Sorted so the tree the search builds -- and therefore every angle
    // derived from it -- does not depend on the order the describe
    // happened to list relationships in.
    for (const name of [...frontier].sort((a, b) => a.localeCompare(b))) {
      for (const neighbour of [...(neighbours.get(name) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      )) {
        if (ring.has(neighbour)) continue;
        ring.set(neighbour, (ring.get(name) ?? 0) + 1);
        parents.set(neighbour, name);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  const furthest = Math.max(0, ...ring.values());
  for (const table of tables) {
    if (!ring.has(table)) ring.set(table, furthest + 1);
  }
  return { ring, parents };
}

/** How many joins hang off this table at its deepest, following the tree
 *  the ring search built. Depth-capped: the tree cannot cycle, but a
 *  malformed one must not be able to run away. */
function subtreeDepth(
  name: string,
  children: Map<string, string[]>,
  depth = 0,
): number {
  if (depth > 64) return depth;
  const next = children.get(name) ?? [];
  if (next.length === 0) return 0;
  return 1 + Math.max(...next.map((c) => subtreeDepth(c, children, depth + 1)));
}


/** The rectangle the graph is asked to settle into: landscape, because
 *  the pane is. */
const AREA_ASPECT = 16 / 9;
const ROUNDS = 400;

/**
 * Fruchterman-Reingold, seeded and deterministic.
 *
 * Every pair of tables pushes apart; every join pulls together; the step
 * size cools each round so the graph settles rather than oscillating.
 * A final pass separates any two boxes still overlapping, because a
 * legible diagram matters more here than a perfectly minimal energy.
 */
function relax(
  centres: Map<string, { x: number; y: number }>,
  edges: Relationship[],
  tables: string[],
  heightOf: (table: string) => number,
): void {
  const count = tables.length;
  if (count < 2) return;

  const spacing = NODE_WIDTH + NODE_CLEARANCE;
  const area = count * spacing * spacing * AREA_ASPECT;
  const ideal = Math.sqrt(area / count);
  let step = ideal;

  for (let round = 0; round < ROUNDS; round++) {
    const force = new Map(tables.map((t) => [t, { x: 0, y: 0 }]));

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = centres.get(tables[i]);
        const b = centres.get(tables[j]);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        // Two tables seeded at the same point would divide by zero; a
        // fixed nudge separates them without randomness.
        if (dx === 0 && dy === 0) {
          dx = (i + 1) * 0.01;
          dy = (j + 1) * 0.01;
        }
        const distance = Math.max(Math.hypot(dx, dy), 0.01);
        const push = (ideal * ideal) / distance;
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        const fa = force.get(tables[i]);
        const fb = force.get(tables[j]);
        if (fa) { fa.x += fx; fa.y += fy; }
        if (fb) { fb.x -= fx; fb.y -= fy; }
      }
    }

    for (const edge of edges) {
      const a = centres.get(edge.table as string);
      const b = centres.get(edge.refTable as string);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(Math.hypot(dx, dy), 0.01);
      const pull = (distance * distance) / ideal;
      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;
      const fa = force.get(edge.table as string);
      const fb = force.get(edge.refTable as string);
      if (fa) { fa.x -= fx; fa.y -= fy; }
      if (fb) { fb.x += fx; fb.y += fy; }
    }

    for (const table of tables) {
      const centre = centres.get(table);
      const f = force.get(table);
      if (!centre || !f) continue;
      const magnitude = Math.max(Math.hypot(f.x, f.y), 0.01);
      const move = Math.min(magnitude, step);
      centre.x += (f.x / magnitude) * move;
      centre.y += (f.y / magnitude) * move;
    }
    step = Math.max(step * 0.975, ideal / 40);
  }

  separate(centres, tables, heightOf);
}

/** Push apart any two boxes still overlapping after the relaxation. */
function separate(
  centres: Map<string, { x: number; y: number }>,
  tables: string[],
  heightOf: (table: string) => number,
): void {
  const minX = NODE_WIDTH + 28;
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < tables.length; i++) {
      for (let j = i + 1; j < tables.length; j++) {
        const a = centres.get(tables[i]);
        const b = centres.get(tables[j]);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // Cards differ in height, so the clearance two of them need is
        // the average of theirs rather than one fixed number.
        const minY =
          (heightOf(tables[i]) + heightOf(tables[j])) / 2 + 28;
        const overlapX = minX - Math.abs(dx);
        const overlapY = minY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        // Along whichever axis needs the smaller correction.
        if (overlapX / minX < overlapY / minY) {
          const shift = (overlapX / 2) * (dx < 0 ? -1 : 1);
          a.x -= shift;
          b.x += shift;
        } else {
          const shift = (overlapY / 2) * (dy < 0 ? -1 : 1);
          a.y -= shift;
          b.y += shift;
        }
      }
    }
    if (!moved) return;
  }
}

/**
 * Where each table and join sits: the hub at the centre, everything else
 * on elliptical rings around it.
 *
 * Deterministic throughout — the hub breaks ties by name and each ring is
 * ordered by name — because a diagram that rearranges itself when nothing
 * changed reads as unreliable rather than as informative.
 */
export function layoutModel(detail: SemanticViewDetail): ModelLayout {
  const tables = detail.tables.map((t) => t.name);
  if (tables.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const edges = realEdges(detail);

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.table as string, [
      ...(outgoing.get(edge.table as string) ?? []),
      edge.refTable as string,
    ]);
  }

  // Keys first, then dimensions, metrics and facts: a card with room for
  // eight rows should spend them on what identifies the table.
  const columnsByTable = keyColumnsOf(edges);
  const collect = (fields: FieldInfo[], kind: ModelColumn["kind"]) => {
    for (const field of fields) {
      columnsByTable.set(field.table, [
        ...(columnsByTable.get(field.table) ?? []),
        { name: field.name, dataType: field.dataType, kind, key: false },
      ]);
    }
  };
  collect(detail.dimensions, "dimension");
  collect(detail.metrics, "metric");
  collect(detail.facts, "fact");

  const heightOf = (table: string): number => {
    const rows = Math.min((columnsByTable.get(table) ?? []).length, MAX_ROWS);
    return NODE_HEADER + rows * ROW_HEIGHT + (rows > 0 ? 6 : 0);
  };

  const hub = hubOf(tables, edges);
  const { ring, parents } = ringsFrom(hub, tables, edges);
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }

  const byRing = new Map<number, string[]>();
  for (const table of [...tables].sort((a, b) => a.localeCompare(b))) {
    const index = ring.get(table) ?? 0;
    byRing.set(index, [...(byRing.get(index) ?? []), table]);
  }

  // Each table's direction from the centre. The first ring fans out all
  // the way round; past that a table takes its parent's direction, so a
  // chain radiates straight outward instead of spiralling — which is what
  // made a chain-shaped model come out taller than it was wide.
  const angles = new Map<string, number>();
  const furthestRing = Math.max(...byRing.keys());
  for (let index = 1; index <= furthestRing; index++) {
    const names = byRing.get(index) ?? [];
    if (names.length === 0) continue;

    const withParent = names.filter((name) => angles.has(parents.get(name) ?? ""));
    const withoutParent = names.filter(
      (name) => !angles.has(parents.get(name) ?? ""),
    );

    // Anything attached to the hub itself, plus tables joined to nothing,
    // share the full circle -- deepest branch first, so the longest run of
    // tables is aimed along the wide axis where there is room for it. A
    // chain is linear whatever the layout does; what it can decide is
    // which way the chain points.
    const ordered = [...withoutParent].sort((a, b) => {
      const byDepth = subtreeDepth(b, children) - subtreeDepth(a, children);
      return byDepth !== 0 ? byDepth : a.localeCompare(b);
    });
    ordered.forEach((name, position) => {
      angles.set(name, (position * 2 * Math.PI) / Math.max(ordered.length, 1));
    });

    // Siblings fan around the direction their parent already points, so a
    // branch stays visually attached to what it branches from.
    const byParent = new Map<string, string[]>();
    for (const name of withParent) {
      const parent = parents.get(name) as string;
      byParent.set(parent, [...(byParent.get(parent) ?? []), name]);
    }
    for (const [parent, children] of byParent) {
      const base = angles.get(parent) ?? 0;
      children.forEach((name, position) => {
        // A lone child continues its parent's branch, turned slightly so
        // a long chain curves around the centre instead of shooting off
        // in one direction and stretching the diagram flat.
        const angle =
          children.length === 1
            ? base + CHAIN_DRIFT
            : base + (position - (children.length - 1) / 2) * SIBLING_SPREAD;
        angles.set(name, angle);
      });
    }
  }

  // Centres, in a space centred on the origin; shifted into view once the
  // extent is known.
  const centres = new Map<string, { x: number; y: number }>();
  for (const [index, names] of byRing) {
    if (index === 0) {
      names.forEach((name) => centres.set(name, { x: 0, y: 0 }));
      continue;
    }
    // Wide enough that the boxes on this ring cannot touch, however many
    // of them there are.
    const needed = (names.length * (NODE_WIDTH + NODE_CLEARANCE)) / (2 * Math.PI);
    const radius = Math.max(RING_GAP * index, needed);
    names.forEach((name) => {
      const angle = angles.get(name) ?? 0;
      centres.set(name, {
        x: Math.cos(angle) * radius * ASPECT,
        y: Math.sin(angle) * radius,
      });
    });
  }

  // Relax the radial seed into two dimensions.
  //
  // Rings alone leave a chain drawn as a straight run of boxes, which is
  // the shape this layout exists to avoid: most of the pane empty and the
  // model reading as a list. A few hundred rounds of the usual
  // spring-and-repulsion model lets a chain bend and the whole graph
  // settle into the rectangle instead.
  //
  // Seeded from the rings and run for a fixed count with no randomness,
  // so it is still exactly reproducible -- the objection to a live
  // force-directed layout was never the physics, it was arriving
  // somewhere different every time.
  relax(centres, edges, tables, heightOf);

  const minX = Math.min(...[...centres.values()].map((c) => c.x)) - NODE_WIDTH / 2;
  const minY = Math.min(...[...centres.values()].map((c) => c.y)) - NODE_HEIGHT / 2;

  const nodes: ModelNode[] = tables
    .map((name) => {
      const centre = centres.get(name) ?? { x: 0, y: 0 };
      const all = columnsByTable.get(name) ?? [];
      const height = heightOf(name);
      return {
        name,
        ring: ring.get(name) ?? 0,
        x: centre.x - NODE_WIDTH / 2 - minX + PADDING,
        y: centre.y - height / 2 - minY + PADDING,
        width: NODE_WIDTH,
        height,
        fieldCount: all.length,
        columns: all.slice(0, MAX_ROWS),
        hiddenColumns: Math.max(0, all.length - MAX_ROWS),
        kind: (outgoing.get(name) ?? []).length > 0 ? "fact" : "dimension",
      } satisfies ModelNode;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

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
        x1: from.x + from.width / 2,
        y1: from.y + from.height / 2,
        x2: to.x + to.width / 2,
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
