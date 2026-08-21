import type { CompositeDefinition } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import type { CompositeViewDetail } from "../models/availability";

/**
 * The model's shape, built from the draft rather than fetched.
 *
 * `/api/composites/{id}/describe` answers for the model **as saved**. The
 * canvas draws the model **as being edited**. Those are different things
 * the moment somebody adds a view, and using the saved one meant every
 * container reported "no fields" for a view that was plainly on screen —
 * because the server was describing a model that did not have it yet.
 *
 * So the shape is assembled here from the member describes the page has
 * already fetched. The result is the same structure the endpoint
 * returns, which is what lets the canvas, the field list and the
 * reachability rules stay indifferent to where it came from.
 *
 * The server keeps its endpoint: a report or an explore reads a model it
 * did not author, and for those the saved definition is exactly right.
 */
export function compositeDetailFromDraft(
  definition: CompositeDefinition,
  describes: Record<string, SemanticViewDetail | undefined>,
  unreadable: string[] = [],
): CompositeViewDetail {
  const folder = folderName(definition);
  const dimensions: CompositeViewDetail["dimensions"] = [];
  const metrics: CompositeViewDetail["metrics"] = [];
  const memberGraphs: NonNullable<CompositeViewDetail["memberGraphs"]> = [];
  const memberErrors: Record<string, string> = {};

  // Columns already conformed are not offered a second time under their
  // member: two ways to group by one thing answer differently depending
  // which was dragged.
  const bound = new Map<string, Set<string>>();
  for (const shared of definition.sharedDimensions) {
    for (const [alias, binding] of Object.entries(shared.bindings)) {
      const key = alias.toLowerCase();
      if (!bound.has(key)) bound.set(key, new Set());
      bound.get(key)!.add(`${binding.table}.${binding.column}`.toUpperCase());
    }
    dimensions.push({ table: folder, name: shared.name, dataType: "TEXT" });
  }

  for (const member of definition.members) {
    const key = member.alias.toLowerCase();
    const detail = describes[key];
    if (!detail) {
      memberErrors[key] = unreadable.some((a) => a.toLowerCase() === key)
        ? "Snowflake refused to describe it, or it no longer exists."
        : "Still reading this view.";
      continue;
    }
    memberGraphs.push({
      alias: member.alias,
      tables: detail.tables ?? [],
      relationships: detail.relationships ?? [],
    });
    const taken = bound.get(key) ?? new Set<string>();
    for (const field of detail.dimensions ?? []) {
      if (!field.table || !field.name) continue;
      if (taken.has(`${field.table}.${field.name}`.toUpperCase())) continue;
      dimensions.push({
        table: member.alias,
        name: `${field.table}.${field.name}`,
        dataType: field.dataType,
      });
    }
    for (const metric of detail.metrics ?? []) {
      if (!metric.table || !metric.name) continue;
      metrics.push({
        table: member.alias,
        name: `${metric.table}.${metric.name}`,
        dataType: metric.dataType,
      });
    }
  }

  for (const derived of definition.derivedMetrics) {
    metrics.push({ table: folder, name: derived.name, dataType: null });
  }

  return {
    tables: [
      { name: folder },
      ...definition.members.map((member) => ({ name: member.alias })),
    ],
    relationships: [],
    dimensions,
    metrics,
    facts: [],
    memberGraphs,
    memberErrors,
  };
}

/** The folder shared fields sit under: the model's own name, kept clear
 *  of any member alias so a field reference stays unambiguous. Mirrors
 *  `folder_name` on the server. */
export function folderName(definition: CompositeDefinition): string {
  let name = (definition.name || "Model").trim() || "Model";
  const aliases = new Set(
    definition.members.map((member) => member.alias.toLowerCase()),
  );
  while (aliases.has(name.toLowerCase())) name = `${name} `;
  return name;
}
