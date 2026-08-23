import { joinGraph, reachable } from "../explorer/joins";
import type { SemanticViewDetail } from "../api/types";
import type { Wells } from "../explorer/wells";

/**
 * Which of a model's fields can still be added, and why the rest cannot.
 *
 * A model relaxes one rule and keeps another, and both have to be said
 * out loud or a field list offers questions the query will refuse.
 *
 * **Relaxed: across members.** Two views meet on their conformed
 * dimensions, so a metric in one and a metric in another go together
 * freely — that is the whole point of the model.
 *
 * **Kept: inside a member.** Each view still has its own join graph, and
 * a metric fixes the base entity there exactly as it does when that view
 * is queried alone. Asking for a metric and a dimension the view cannot
 * connect fails inside the branch, before anything is joined.
 *
 * **Added: the model's own rule.** A question that reaches two members
 * needs a shared dimension to line their answers up on. Without one there
 * is nothing to join, and the planner refuses it.
 *
 * This mirrors the server (`app/composites/planner.py` and the branch's
 * own `plan_join`) for the opposite purpose: the server decides whether a
 * query CAN run; this decides whether a field should be OFFERED.
 */

/** `sales` from `sales.ORDERS.REVENUE`; "" for a shared dimension. */
function memberOf(ref: string): string {
  const head = ref.split(".", 1)[0];
  return head;
}

/** `ORDERS` from `sales.ORDERS.REVENUE` — the member's OWN table. */
function memberTable(ref: string): string {
  const parts = ref.split(".");
  return parts.length >= 3 ? parts[1].toUpperCase() : "";
}

/** One member view's own shape, carried out with the model's describe so
 *  a client can answer reachability without describing every member. */
export interface MemberGraph {
  alias: string;
  tables: { name: string }[];
  relationships: SemanticViewDetail["relationships"];
}

/** A model's describe: a view's shape, plus each member's own graph. */
export type CompositeViewDetail = SemanticViewDetail & {
  memberGraphs?: MemberGraph[];
  /** alias -> why that view contributed no fields. Empty when every
   *  member answered. Carried so the UI can report what actually
   *  happened rather than assuming it was a permission. */
  memberErrors?: Record<string, string>;
  /** Which real column each shared dimension IS, per member, keyed by
   *  the dimension's own field reference. Grouping by "Brand" means
   *  grouping by PART in one view and BRAND_DIM in another, and a client
   *  cannot deduce that -- without it, it cannot tell which measures can
   *  still break the dimension down. */
  sharedBindings?: Record<string, Record<string, { table: string; column: string }>>;
};

export function compositeAvailability(
  detail: CompositeViewDetail,
  wells: Wells,
): Map<string, string> {
  const blocked = new Map<string, string>();
  const graphs = detail.memberGraphs ?? [];
  if (graphs.length === 0) return blocked;

  const folder = (detail.tables ?? [])[0]?.name ?? "";
  const isShared = (ref: string) =>
    memberOf(ref).toLowerCase() === folder.toLowerCase();

  const selected = new Set([...wells.axis, ...wells.legend, ...wells.values]);
  const chosenDimensions = [...wells.axis, ...wells.legend];
  const chosenMetrics = wells.values;
  const sharedChosen = chosenDimensions.some(isShared);

  // Which members the question already reaches. A shared dimension names
  // no member, so it does not put one in play on its own.
  const active = new Set(
    [...chosenDimensions, ...chosenMetrics]
      .filter((ref) => !isShared(ref))
      .map((ref) => memberOf(ref).toLowerCase()),
  );

  const byAlias = new Map(
    graphs.map((graph) => [graph.alias.toLowerCase(), graph]),
  );

  const bindings = detail.sharedBindings ?? {};

  /** Tables of this member already named by the selection.
   *
   *  A shared dimension counts. It is not an abstraction the branch ever
   *  sees: it is bound to a real column, the branch groups by that
   *  column, and a measure that cannot reach its table is as
   *  unanswerable as if the column had been picked directly. Leaving
   *  these out is why choosing a conformed dimension and an unreachable
   *  measure was only refused at run time. */
  function tablesChosenIn(alias: string, refs: string[]): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      if (isShared(ref)) {
        const bound = bindings[ref]?.[alias] ?? bindings[ref]?.[alias.toLowerCase()];
        const match =
          bound ??
          Object.entries(bindings[ref] ?? {}).find(
            ([bindingAlias]) => bindingAlias.toLowerCase() === alias,
          )?.[1];
        if (match?.table) out.push(match.table.toUpperCase());
        continue;
      }
      if (memberOf(ref).toLowerCase() !== alias) continue;
      const table = memberTable(ref);
      if (table) out.push(table);
    }
    return out;
  }

  function block(ref: string, reason: string) {
    if (!selected.has(ref)) blocked.set(ref, reason);
  }

  const everyField = [
    ...(detail.dimensions ?? []).map((f) => ({ field: f, kind: "dimension" })),
    ...(detail.metrics ?? []).map((f) => ({ field: f, kind: "metric" })),
  ];

  for (const { field, kind } of everyField) {
    const ref = `${field.table}.${field.name}`;
    if (selected.has(ref)) continue;
    if (isShared(ref)) continue; // A shared dimension is always askable.

    const alias = memberOf(ref).toLowerCase();
    const graph = byAlias.get(alias);

    // --- the model's own rule -------------------------------------
    // Reaching a second member with nothing to line them up on.
    if (!sharedChosen && active.size > 0 && !active.has(alias)) {
      block(
        ref,
        `${field.table} and the views already chosen have nothing to line ` +
          "their answers up on. Add a shared dimension first, or pick " +
          "fields from one view.",
      );
      continue;
    }

    if (!graph) continue;

    // --- the member's own join graph -------------------------------
    const edges = joinGraph({
      tables: graph.tables,
      relationships: graph.relationships,
      dimensions: [],
      metrics: [],
      facts: [],
    } as SemanticViewDetail);
    if (![...edges.values()].some((set) => set.size > 0)) continue;

    const table = memberTable(ref);
    if (!table) continue;

    if (kind === "metric") {
      // A candidate measure has to reach every dimension already chosen
      // FROM THIS MEMBER. A dimension of another member is joined on a
      // conformed key, not on this view's graph.
      const seen = reachable(edges, table);
      const unreachable = tablesChosenIn(alias, chosenDimensions).filter(
        (t) => !seen.has(t),
      );
      if (unreachable.length) {
        block(
          ref,
          `${field.name} is measured per ${table}, so it cannot be broken ` +
            `down by ${unreachable.join(", ")} in the same view.`,
        );
      }
      continue;
    }

    // A candidate dimension has to be reachable FROM every measure of
    // this member already chosen -- measures constrain, dimensions do not.
    for (const metricTable of tablesChosenIn(alias, chosenMetrics)) {
      if (!reachable(edges, metricTable).has(table)) {
        block(
          ref,
          `The measure chosen from ${graph.alias} is per ${metricTable}, ` +
            `which does not reach ${table}.`,
        );
        break;
      }
    }
  }

  return blocked;
}
