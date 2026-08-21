import type {
  Binding,
  CompositeDefinition,
  SharedDimension,
} from "../api/composites";
import { prettyName } from "../models/matching";

/**
 * The gestures on the canvas, as changes to a definition.
 *
 * Every one takes a definition and returns a new one, so the canvas holds
 * no model state of its own and the Design and Fields tabs cannot
 * disagree — there is one draft, and both are views onto it.
 *
 * Kept out of the drag handler on purpose: these are the rules of the
 * model, and rules that live in an event handler can only be tested by
 * simulating a drag.
 */

export interface Endpoint {
  /** The member the column belongs to. */
  alias: string;
  table: string;
  column: string;
}

export type EditResult =
  | { ok: true; definition: CompositeDefinition }
  /** Refused, with the sentence to show. A refusal is a thing the person
   *  needs to understand, not a drag that silently does nothing. */
  | { ok: false; reason: string };

function sameColumn(binding: Binding | undefined, end: Endpoint): boolean {
  return (
    !!binding &&
    binding.table.toUpperCase() === end.table.toUpperCase() &&
    binding.column.toUpperCase() === end.column.toUpperCase()
  );
}

/** The shared dimension this column already takes part in, if any. */
export function dimensionAt(
  definition: CompositeDefinition,
  end: Endpoint,
): SharedDimension | undefined {
  return definition.sharedDimensions.find((shared) =>
    sameColumn(
      Object.entries(shared.bindings).find(
        ([alias]) => alias.toLowerCase() === end.alias.toLowerCase(),
      )?.[1],
      end,
    ),
  );
}

/** A name no other shared dimension has, so two Customers cannot exist. */
function freeName(definition: CompositeDefinition, wanted: string): string {
  const taken = new Set(
    definition.sharedDimensions.map((s) => s.name.trim().toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 99; n += 1) {
    if (!taken.has(`${wanted} ${n}`.toLowerCase())) return `${wanted} ${n}`;
  }
  return `${wanted} ${Date.now()}`;
}

/**
 * Drawing an edge between two columns.
 *
 * Four outcomes, and which one applies is decided here rather than by the
 * shape of the drag:
 *
 * - within one view — refused: a view's own joins are Snowflake's, and a
 *   conformed dimension relates *different* views;
 * - neither end mapped — a new shared dimension, named from the column;
 * - one end mapped — the other joins it, which is how a model reaches a
 *   third view without collecting pairwise mappings;
 * - both mapped, to different dimensions — refused: merging two named
 *   concepts is a decision somebody makes, not a side effect of a drag.
 */
export function relate(
  definition: CompositeDefinition,
  from: Endpoint,
  to: Endpoint,
): EditResult {
  if (from.alias.toLowerCase() === to.alias.toLowerCase()) {
    return {
      ok: false,
      reason:
        `Both columns are in ${from.alias}. A view's own joins come from ` +
        "Snowflake; a shared dimension is how two DIFFERENT views line up.",
    };
  }

  const left = dimensionAt(definition, from);
  const right = dimensionAt(definition, to);

  if (left && right) {
    if (left === right) {
      return { ok: false, reason: `Those columns are already ${left.name}.` };
    }
    return {
      ok: false,
      reason:
        `${from.column} is already ${left.name} and ${to.column} is ` +
        `already ${right.name}. Remove one of them first — merging two ` +
        "named concepts is a decision, not a drag.",
    };
  }

  const existing = left ?? right;
  const joining = left ? to : from;

  if (existing) {
    const clash = Object.keys(existing.bindings).find(
      (alias) => alias.toLowerCase() === joining.alias.toLowerCase(),
    );
    if (clash) {
      return {
        ok: false,
        reason:
          `${existing.name} already reads ${joining.alias} from ` +
          `${existing.bindings[clash].table}.${existing.bindings[clash].column}. ` +
          "A view holds one column per shared dimension.",
      };
    }
    return {
      ok: true,
      definition: {
        ...definition,
        sharedDimensions: definition.sharedDimensions.map((shared) =>
          shared === existing
            ? {
                ...shared,
                bindings: {
                  ...shared.bindings,
                  [joining.alias]: {
                    table: joining.table,
                    column: joining.column,
                  },
                },
              }
            : shared,
        ),
      },
    };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      sharedDimensions: [
        ...definition.sharedDimensions,
        {
          name: freeName(definition, prettyName(from.column)),
          bindings: {
            [from.alias]: { table: from.table, column: from.column },
            [to.alias]: { table: to.table, column: to.column },
          },
        },
      ],
    },
  };
}

/** Naming a shared dimension, from the canvas. */
export function rename(
  definition: CompositeDefinition,
  index: number,
  name: string,
): EditResult {
  const clean = name.trim();
  if (!clean) return { ok: false, reason: "A shared dimension needs a name." };
  const clash = definition.sharedDimensions.some(
    (shared, i) => i !== index && shared.name.trim().toLowerCase() === clean.toLowerCase(),
  );
  if (clash) {
    return { ok: false, reason: `There is already a ${clean}.` };
  }
  return {
    ok: true,
    definition: {
      ...definition,
      sharedDimensions: definition.sharedDimensions.map((shared, i) =>
        i === index ? { ...shared, name: clean } : shared,
      ),
    },
  };
}

/**
 * Removing an edge.
 *
 * Dropping one binding of a three-way dimension leaves the other two,
 * which is still a mapping. Dropping one of two leaves a dimension bound
 * to a single view — which is not a shared dimension at all, so the whole
 * thing goes.
 */
export function unrelate(
  definition: CompositeDefinition,
  index: number,
  alias?: string,
): EditResult {
  const shared = definition.sharedDimensions[index];
  if (!shared) return { ok: false, reason: "That mapping is already gone." };

  const remaining = alias
    ? Object.entries(shared.bindings).filter(
        ([key]) => key.toLowerCase() !== alias.toLowerCase(),
      )
    : [];

  if (remaining.length < 2) {
    return {
      ok: true,
      definition: {
        ...definition,
        sharedDimensions: definition.sharedDimensions.filter(
          (_, i) => i !== index,
        ),
      },
    };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      sharedDimensions: definition.sharedDimensions.map((current, i) =>
        i === index
          ? {
              ...current,
              bindings: Object.fromEntries(remaining),
              labels: Object.fromEntries(
                Object.entries(current.labels ?? {}).filter(
                  ([key]) => key.toLowerCase() !== (alias ?? "").toLowerCase(),
                ),
              ),
            }
          : current,
      ),
    },
  };
}

/**
 * Adding a view to the model.
 *
 * The alias is suggested from the view's name and made unique, because
 * every field reference in the model is prefixed with it — two members
 * sharing one would make every reference a coin toss. Suggested, not
 * imposed: what a team calls a view and what it calls that view's part
 * in a model are different questions, so the alias stays editable.
 */
export function suggestAlias(view: string, taken: string[]): string {
  const base =
    view
      .toLowerCase()
      .replace(/_?(sv|semantic|view)$/g, "")
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "view";
  const start = /^[a-z]/.test(base) ? base : `v${base}`;
  const used = taken.map((alias) => alias.toLowerCase());
  if (!used.includes(start)) return start;
  for (let n = 2; n < 99; n += 1) {
    if (!used.includes(`${start}${n}`)) return `${start}${n}`;
  }
  return `${start}_x`;
}

export function addMember(
  definition: CompositeDefinition,
  view: { database: string; schema: string; name: string },
): EditResult {
  const already = definition.members.some(
    (member) =>
      member.database.toUpperCase() === view.database.toUpperCase() &&
      member.schema.toUpperCase() === view.schema.toUpperCase() &&
      member.view.toUpperCase() === view.name.toUpperCase(),
  );
  if (already) {
    return {
      ok: false,
      reason: `${view.name} is already in this model. A composite joins different views.`,
    };
  }
  return {
    ok: true,
    definition: {
      ...definition,
      members: [
        ...definition.members,
        {
          alias: suggestAlias(
            view.name,
            definition.members.map((member) => member.alias),
          ),
          database: view.database,
          schema: view.schema,
          view: view.name,
        },
      ],
    },
  };
}

/**
 * Removing a view.
 *
 * Its bindings go with it, and any shared dimension left bound to fewer
 * than two views goes too — one binding is not a shared dimension, and
 * leaving one would save a model the server refuses. Derived metrics
 * that referenced the view go for the same reason.
 */
export function removeMember(
  definition: CompositeDefinition,
  alias: string,
): EditResult {
  const key = alias.toLowerCase();
  const withoutIt = (map: Record<string, Binding>) =>
    Object.fromEntries(
      Object.entries(map).filter(([bound]) => bound.toLowerCase() !== key),
    );

  return {
    ok: true,
    definition: {
      ...definition,
      members: definition.members.filter(
        (member) => member.alias.toLowerCase() !== key,
      ),
      sharedDimensions: definition.sharedDimensions
        .map((shared) => ({
          ...shared,
          bindings: withoutIt(shared.bindings),
          labels: withoutIt(shared.labels ?? {}),
        }))
        .filter((shared) => Object.keys(shared.bindings).length >= 2),
      derivedMetrics: definition.derivedMetrics.filter(
        (metric) => !JSON.stringify(metric.expr).includes(`"${alias}:`),
      ),
    },
  };
}

/** Renaming a view's alias, carrying every reference to it along. */
export function renameMember(
  definition: CompositeDefinition,
  from: string,
  to: string,
): EditResult {
  const clean = to.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(clean)) {
    return {
      ok: false,
      reason:
        "A view's name in the model starts with a letter and holds only " +
        "letters, digits and underscores — it is the prefix on every field.",
    };
  }
  const clash = definition.members.some(
    (member) =>
      member.alias.toLowerCase() !== from.toLowerCase() &&
      member.alias.toLowerCase() === clean.toLowerCase(),
  );
  if (clash) return { ok: false, reason: `Another view is already called ${clean}.` };

  const rekey = (map: Record<string, Binding>) =>
    Object.fromEntries(
      Object.entries(map).map(([alias, binding]) => [
        alias.toLowerCase() === from.toLowerCase() ? clean : alias,
        binding,
      ]),
    );

  return {
    ok: true,
    definition: {
      ...definition,
      members: definition.members.map((member) =>
        member.alias.toLowerCase() === from.toLowerCase()
          ? { ...member, alias: clean }
          : member,
      ),
      sharedDimensions: definition.sharedDimensions.map((shared) => ({
        ...shared,
        bindings: rekey(shared.bindings),
        labels: shared.labels ? rekey(shared.labels) : undefined,
      })),
      // A derived metric names its operands `alias:TABLE.METRIC`, so the
      // prefix has to move with the view or the metric stops resolving.
      derivedMetrics: definition.derivedMetrics.map((metric) => ({
        ...metric,
        expr: JSON.parse(
          JSON.stringify(metric.expr).replaceAll(`"${from}:`, `"${clean}:`),
        ),
      })),
    },
  };
}
