import type { CompositeDefinition } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import type { CompositeViewDetail } from "../models/availability";
import { suggestSharedDimensions } from "../models/matching";
import type { GhostEdge } from "./layout";

/**
 * Suggested mappings for the canvas, from the model's own describe.
 *
 * The matcher wants one describe per member; the composite describe has
 * them flattened into one list with the member in each field's `table`.
 * Unflattening here means auto-detect costs no extra request and — more
 * to the point — the canvas and the form suggest from exactly the same
 * data, so they cannot offer different things.
 */
export function memberDetails(
  definition: CompositeDefinition,
  detail: CompositeViewDetail,
): Record<string, SemanticViewDetail> {
  const out: Record<string, SemanticViewDetail> = {};
  for (const member of definition.members) {
    const alias = member.alias.toLowerCase();
    const graph = (detail.memberGraphs ?? []).find(
      (candidate) => candidate.alias.toLowerCase() === alias,
    );
    out[alias] = {
      tables: graph?.tables ?? [],
      relationships: graph?.relationships ?? [],
      dimensions: [],
      metrics: [],
      facts: [],
    };
  }

  const split = (name: string) => {
    const dot = name.indexOf(".");
    return dot > 0 ? { table: name.slice(0, dot), name: name.slice(dot + 1) } : null;
  };

  for (const field of detail.dimensions ?? []) {
    const alias = (field.table ?? "").toLowerCase();
    const parts = split(field.name);
    // A shared dimension has no member and no inner table; it is already
    // mapped, so it is not a candidate for mapping.
    if (!out[alias] || !parts) continue;
    out[alias].dimensions.push({ ...parts, dataType: field.dataType });
  }
  return out;
}

/** Candidates, as edges the canvas can draw dashed. */
export function ghostsFor(
  definition: CompositeDefinition,
  detail: CompositeViewDetail,
  dismissed: ReadonlySet<string> = new Set(),
): GhostEdge[] {
  const details = memberDetails(definition, detail);
  return suggestSharedDimensions(
    definition.members,
    details,
    definition.sharedDimensions,
  )
    .map((candidate) => ({
      name: candidate.name,
      reason: candidate.reason,
      bindings: candidate.bindings,
    }))
    .filter((ghost) => !dismissed.has(ghostKey(ghost)));
}

/** A candidate's identity, so dismissing one is remembered across the
 *  re-suggestion that follows every edit. Same shape the form uses. */
export function ghostKey(ghost: GhostEdge): string {
  return Object.entries(ghost.bindings)
    .map(([alias, binding]) => `${alias}.${binding.table}.${binding.column}`)
    .sort()
    .join("|");
}
