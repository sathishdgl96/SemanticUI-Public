import type { CompositeDefinition } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import { suggestSharedDimensions } from "../models/matching";
import type { GhostEdge } from "./layout";

/**
 * Suggested mappings for the canvas.
 *
 * Takes the per-member describes the page already holds. It used to take
 * the model's flattened shape and unflatten it back — two conversions in
 * sequence, in opposite directions, with the matcher's real input in the
 * middle of them.
 *
 * Returns candidates as edges the canvas can draw dashed.
 */
export function ghostsFor(
  definition: CompositeDefinition,
  describes: Record<string, SemanticViewDetail | undefined>,
  dismissed: ReadonlySet<string> = new Set(),
): GhostEdge[] {
  return suggestSharedDimensions(
    definition.members,
    describes,
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
