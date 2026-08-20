/** How one field relates to every other field in the model.
 *
 *  Two questions, and they are not the same one:
 *
 *  1. HOW are the two tables connected -- which joins, on which columns,
 *     in which direction.
 *  2. CAN the two fields be asked for in one query.
 *
 *  The second is the rule `explorer/joins.ts` uses to decide what to
 *  offer and `backend/app/semantic/joins.py` enforces on the way to
 *  Snowflake, and it is deliberately asymmetric: a measure fixes the base
 *  entity, so everything finer than it becomes unaskable, while two
 *  dimensions never rule each other out because the server bridges them
 *  through a third entity. Restating that here rather than re-deriving it
 *  keeps the diagram from promising a query the explorer will refuse.
 */

import type { FieldInfo, Relationship, SemanticViewDetail } from "../api/types";
import { realEdges } from "./graph";

export type FieldKind = "dimension" | "metric" | "fact";

/** One hop along a join path, already oriented the way it is being read. */
export interface JoinStep {
  relationship: string;
  from: string;
  to: string;
  /** "O_CUSTKEY = C_CUSTKEY", or null when the describe carried no keys. */
  on: string | null;
}

export type Link =
  /** The same table -- no join involved. */
  | { kind: "same" }
  /** The selected field's table references the other, directly or through
   *  intermediates: reading the path moves from finer grain to coarser. */
  | { kind: "downstream"; path: JoinStep[] }
  /** The other table references the selected field's table. */
  | { kind: "upstream"; path: JoinStep[] }
  /** Neither reaches the other, but a third entity reaches both, which is
   *  what the server smuggles into the query to make it compile. */
  | { kind: "bridged"; through: string; path: JoinStep[]; otherPath: JoinStep[] }
  /** No join path in either direction, through anything. */
  | { kind: "none" };

export interface FieldRelation {
  ref: string;
  table: string;
  name: string;
  kind: FieldKind;
  dataType: string | null;
  link: Link;
  /** How many joins away, for ordering. Same table is 0. */
  distance: number;
  /** Whether the two can appear in one query, and why not when they cannot. */
  together: { ok: true } | { ok: false; reason: string };
}

interface Hop {
  to: string;
  relationship: string;
  on: string | null;
}

type Adjacency = Map<string, Hop[]>;

function upper(value: string | null | undefined): string {
  return (value ?? "").toUpperCase();
}

function keysOf(relationship: Relationship): string | null {
  const foreign = relationship.foreignKey ?? [];
  const referenced = relationship.refKey ?? [];
  if (!foreign.length || !referenced.length) return null;
  return `${foreign.join(", ")} = ${referenced.join(", ")}`;
}

/** Table -> the tables it directly references. Directed: following a hop
 *  always moves from the foreign-key side to the referenced side. */
export function adjacency(detail: SemanticViewDetail): Adjacency {
  const map: Adjacency = new Map();
  for (const table of detail.tables ?? []) {
    if (table?.name) map.set(upper(table.name), []);
  }
  for (const relationship of realEdges(detail)) {
    const from = upper(relationship.table);
    const to = upper(relationship.refTable);
    map.set(from, [
      ...(map.get(from) ?? []),
      { to, relationship: relationship.name, on: keysOf(relationship) },
    ]);
    if (!map.has(to)) map.set(to, []);
  }
  return map;
}

/** The shortest directed path from `start` to `goal`, or null.
 *
 *  Breadth-first over neighbours taken in insertion order, which
 *  `realEdges` sorts by relationship name -- so a model with two equally
 *  short paths always reports the same one. */
export function pathBetween(
  graph: Adjacency,
  start: string,
  goal: string,
): JoinStep[] | null {
  if (start === goal) return [];
  const cameFrom = new Map<string, { from: string; hop: Hop }>();
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift() as string;
    for (const hop of graph.get(node) ?? []) {
      if (seen.has(hop.to)) continue;
      seen.add(hop.to);
      cameFrom.set(hop.to, { from: node, hop });
      if (hop.to === goal) {
        const steps: JoinStep[] = [];
        let cursor = goal;
        while (cursor !== start) {
          const previous = cameFrom.get(cursor);
          if (!previous) return null;
          steps.unshift({
            relationship: previous.hop.relationship,
            from: previous.from,
            to: cursor,
            on: previous.hop.on,
          });
          cursor = previous.from;
        }
        return steps;
      }
      queue.push(hop.to);
    }
  }
  return null;
}

/** Everything reachable from `start`, `start` included. */
export function reachable(graph: Adjacency, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const hop of graph.get(queue.shift() as string) ?? []) {
      if (!seen.has(hop.to)) {
        seen.add(hop.to);
        queue.push(hop.to);
      }
    }
  }
  return seen;
}

/** The nearest entity that reaches both tables, with the path to each.
 *
 *  This is the same repair `plan_join` makes on the server: when neither
 *  of two dimensions reaches the other, naming a third that reaches both
 *  is what lets the query compile. Ranked by total distance so the bridge
 *  is the closest common descendant, and by name so it is stable. */
function bridge(
  graph: Adjacency,
  a: string,
  b: string,
): { through: string; path: JoinStep[]; otherPath: JoinStep[] } | null {
  let best: { through: string; path: JoinStep[]; otherPath: JoinStep[]; cost: number } | null =
    null;
  for (const candidate of [...graph.keys()].sort((x, y) => x.localeCompare(y))) {
    if (candidate === a || candidate === b) continue;
    const toA = pathBetween(graph, candidate, a);
    const toB = pathBetween(graph, candidate, b);
    if (!toA || !toB) continue;
    const cost = toA.length + toB.length;
    if (!best || cost < best.cost) {
      best = { through: candidate, path: toA, otherPath: toB, cost };
    }
  }
  return best ? { through: best.through, path: best.path, otherPath: best.otherPath } : null;
}

export function linkBetween(graph: Adjacency, from: string, to: string): Link {
  if (from === to) return { kind: "same" };
  const forward = pathBetween(graph, from, to);
  if (forward) return { kind: "downstream", path: forward };
  const backward = pathBetween(graph, to, from);
  if (backward) return { kind: "upstream", path: backward };
  const through = bridge(graph, from, to);
  if (through) return { kind: "bridged", ...through };
  return { kind: "none" };
}

export function linkDistance(link: Link): number {
  switch (link.kind) {
    case "same":
      return 0;
    case "downstream":
    case "upstream":
      return link.path.length;
    case "bridged":
      return link.path.length + link.otherPath.length;
    case "none":
      return Number.MAX_SAFE_INTEGER;
  }
}

function allFields(detail: SemanticViewDetail): { field: FieldInfo; kind: FieldKind }[] {
  return [
    ...(detail.dimensions ?? []).map((field) => ({ field, kind: "dimension" as const })),
    ...(detail.metrics ?? []).map((field) => ({ field, kind: "metric" as const })),
    ...(detail.facts ?? []).map((field) => ({ field, kind: "fact" as const })),
  ];
}

/**
 * Whether two fields can be put in one query.
 *
 * A measure fixes the base entity: every dimension in the query has to be
 * reachable from it, and nothing rescues one that is not. Two dimensions
 * never block each other -- the server bridges them -- and two measures
 * constrain only the dimensions around them, not one another.
 */
function combinable(
  graph: Adjacency,
  selected: { table: string; kind: FieldKind },
  other: { table: string; kind: FieldKind },
): { ok: true } | { ok: false; reason: string } {
  const measure = (kind: FieldKind) => kind !== "dimension";
  const a = upper(selected.table);
  const b = upper(other.table);
  if (a === b) return { ok: true };

  if (measure(selected.kind) && !measure(other.kind)) {
    return reachable(graph, a).has(b)
      ? { ok: true }
      : {
          ok: false,
          reason: `Measured per ${selected.table} — cannot break down by ${other.table}.`,
        };
  }
  if (!measure(selected.kind) && measure(other.kind)) {
    return reachable(graph, b).has(a)
      ? { ok: true }
      : {
          ok: false,
          reason: `Measured per ${other.table} — cannot break down by ${selected.table}.`,
        };
  }
  return { ok: true };
}

/**
 * Every other field in the model, and how it relates to `ref`.
 *
 * Sorted nearest first, then by name, so the answer to "what is this
 * column connected to" opens with the tables one join away rather than
 * with whatever the describe happened to list first.
 */
export function relatedFields(
  detail: SemanticViewDetail,
  ref: string,
): FieldRelation[] {
  const [selectedTable] = ref.split(".");
  const selected = allFields(detail).find(
    (entry) => `${entry.field.table}.${entry.field.name}` === ref,
  );
  if (!selected) return [];
  const graph = adjacency(detail);
  const from = upper(selectedTable);

  // One link per table rather than one per field: the relationship is a
  // property of the tables, and a wide model would otherwise walk the
  // same path hundreds of times.
  const links = new Map<string, Link>();
  const linkTo = (table: string): Link => {
    const key = upper(table);
    const existing = links.get(key);
    if (existing) return existing;
    const link = linkBetween(graph, from, key);
    links.set(key, link);
    return link;
  };

  return allFields(detail)
    .filter((entry) => `${entry.field.table}.${entry.field.name}` !== ref)
    .map(({ field, kind }) => {
      const link = linkTo(field.table);
      return {
        ref: `${field.table}.${field.name}`,
        table: field.table,
        name: field.name,
        kind,
        dataType: field.dataType,
        link,
        distance: linkDistance(link),
        together: combinable(
          graph,
          { table: selected.field.table, kind: selected.kind },
          { table: field.table, kind },
        ),
      } satisfies FieldRelation;
    })
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.table !== b.table) return a.table.localeCompare(b.table);
      return a.name.localeCompare(b.name);
    });
}

/** How a table stands relative to the selected field: its own table, on a
 *  join path with it, only connected through a third entity, or not
 *  connected at all. */
export type TableState = "self" | "linked" | "bridged" | "none";

export interface Highlight {
  tables: Map<string, TableState>;
  /** Relationships lying on one of those paths. */
  relationships: Set<string>;
}

/**
 * What the diagram should emphasise while a field is selected.
 *
 * Four states rather than a highlighted/dimmed pair, because in a star
 * schema everything is connected to everything and a binary would light
 * the whole diagram up. What varies -- and what the reader wants -- is
 * HOW: a directed path, only through a bridge, or not at all.
 */
export function highlightFor(
  detail: SemanticViewDetail,
  ref: string | null,
): Highlight | null {
  if (!ref) return null;
  const [table] = ref.split(".");
  const graph = adjacency(detail);
  const from = upper(table);
  const tables = new Map<string, TableState>();
  const relationships = new Set<string>();
  for (const candidate of graph.keys()) {
    const link = linkBetween(graph, from, candidate);
    switch (link.kind) {
      case "same":
        tables.set(candidate, "self");
        break;
      case "downstream":
      case "upstream":
        tables.set(candidate, "linked");
        for (const step of link.path) relationships.add(step.relationship);
        break;
      case "bridged":
        tables.set(candidate, "bridged");
        for (const step of [...link.path, ...link.otherPath]) {
          relationships.add(step.relationship);
        }
        break;
      case "none":
        tables.set(candidate, "none");
        break;
    }
  }
  return { tables, relationships };
}
