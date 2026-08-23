/** Which fields can still be added to an explore, and why the rest cannot.
 *
 *  A `SEMANTIC_VIEW(...)` query is rooted at a base entity Snowflake picks
 *  for itself, and everything else named in the query has to be reachable
 *  from it along declared relationships. Break that and the query fails at
 *  compile time with "Invalid dimension specified" -- after a round trip,
 *  in the model's vocabulary rather than the user's.
 *
 *  This mirrors the rule the server enforces in app/semantic/joins.py, for
 *  the opposite purpose: the server decides whether a query CAN run, this
 *  decides whether a field should be OFFERED. Both were derived from the
 *  same experiments against a real account, and
 *  backend/tests/integration/test_joins_it.py is what keeps them honest.
 *
 *  The asymmetry worth knowing: measures constrain, dimensions do not.
 *  Dimensions the server can always bridge (it joins them through a third
 *  entity), so picking one never rules another out. A measure fixes the
 *  base entity, and everything finer than it becomes unaskable.
 */

import type { SemanticViewDetail } from "../api/types";
import type { Wells } from "./wells";

export type JoinGraph = Map<string, Set<string>>;

export function joinGraph(detail: SemanticViewDetail): JoinGraph {
  const graph: JoinGraph = new Map();
  const node = (name: string) => {
    if (!graph.has(name)) graph.set(name, new Set());
    return graph.get(name)!;
  };
  for (const table of detail.tables ?? []) {
    if (table?.name) node(table.name.toUpperCase());
  }
  for (const relationship of detail.relationships ?? []) {
    const source = relationship?.table?.toUpperCase();
    const target = relationship?.refTable?.toUpperCase();
    if (!source || !target) continue;
    node(source).add(target);
    node(target);
  }
  return graph;
}

export function reachable(graph: JoinGraph, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of graph.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function tableOf(ref: string): string {
  return ref.split(".")[0].toUpperCase();
}

/** Refs that cannot be added right now, each mapped to the reason.
 *
 *  Empty when the view declares no join endpoints at all: without a graph
 *  there is nothing to be confident about, and greying out fields on a guess
 *  is worse than letting the occasional query fail.
 */
export function availability(
  detail: SemanticViewDetail,
  wells: Wells,
): Map<string, string> {
  const blocked = new Map<string, string>();
  const graph = joinGraph(detail);
  if (![...graph.values()].some((edges) => edges.size > 0)) return blocked;

  const selected = new Set([...wells.axis, ...wells.legend, ...wells.values]);
  const dimensionRefs = [...wells.axis, ...wells.legend];
  const metricRefs = wells.values;

  // A candidate MEASURE has to reach every dimension already chosen.
  for (const metric of detail.metrics ?? []) {
    const ref = `${metric.table}.${metric.name}`;
    if (selected.has(ref)) continue;
    const seen = reachable(graph, (metric.table ?? "").toUpperCase());
    const unreachable = dimensionRefs.filter((d) => !seen.has(tableOf(d)));
    if (unreachable.length) {
      blocked.set(
        ref,
        `Measured per ${metric.table} — cannot break down by ${unreachable.join(", ")}.`,
      );
    }
  }

  // A candidate DIMENSION has to be reachable from every measure already
  // chosen. With no measure chosen, nothing is ruled out: the server bridges.
  for (const dimension of detail.dimensions ?? []) {
    const ref = `${dimension.table}.${dimension.name}`;
    if (selected.has(ref)) continue;
    const blocker = metricRefs.find(
      (m) => !reachable(graph, tableOf(m)).has((dimension.table ?? "").toUpperCase()),
    );
    if (blocker) {
      blocked.set(
        ref,
        `Not available with ${blocker} selected — it is measured per ${tableOf(blocker)}.`,
      );
    }
  }

  return blocked;
}
