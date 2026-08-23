import type { CompositeMember, SharedDimension } from "../api/composites";
import type { FieldInfo, SemanticViewDetail } from "../api/types";

/**
 * Finding columns that *might* mean the same thing across member views.
 *
 * Everything here is a **suggestion**, never a decision. The model's own
 * rule is that joins are declared by a person who understands both views:
 * two views having a `CUSTOMER_ID` is a coincidence until somebody says
 * otherwise, and a mapping created silently is exactly how a composite
 * starts reporting numbers nobody can account for.
 *
 * So this ranks candidates and the editor shows them for confirmation.
 * What it buys is the typing, not the judgement.
 */

/** `CUSTOMER_ID` -> `CUSTOMER`; `CLIENT_KEY` -> `CLIENT`. The suffix is
 *  what makes a column a key, not part of what it identifies. */
function withoutKeySuffix(column: string): string {
  return column.replace(/_(ID|KEY|CD|CODE|NO|NUM|NUMBER)$/i, "");
}

/** A column name reduced to what two views would have in common if they
 *  named the same concept in their own house style. */
function normalise(column: string): string {
  return column.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** True for a column that looks like something you would join ON. */
export function looksLikeKey(column: string): boolean {
  return /_(ID|KEY|CD|CODE|NO|NUM|NUMBER)$/i.test(column) || /^ID$/i.test(column);
}

/** `CUSTOMER_ID` -> `Customer`; `ORDER_MONTH` -> `Order month`. What a
 *  person would call the concept, since the model's field list is read by
 *  people rather than by Snowflake. */
export function prettyName(column: string): string {
  const words = withoutKeySuffix(column).split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return column;
  const [first, ...rest] = words.map((word) => word.toLowerCase());
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

export interface Candidate {
  /** What the shared dimension would be called. */
  name: string;
  /** Where each member holds it. */
  bindings: Record<string, { table: string; column: string }>;
  /** Why it was suggested, shown to the person confirming it. */
  reason: string;
  /** Higher is more likely to be a real conformed dimension. */
  score: number;
}

interface Occurrence {
  alias: string;
  field: FieldInfo;
}

/**
 * Columns that appear, by name, in two or more member views.
 *
 * Three strengths of evidence, and the reason is shown so a person can
 * weigh it:
 *
 * 1. the same column name in both, and it looks like a key — the usual
 *    shape of a conformed dimension;
 * 2. the same column name, not key-shaped — often a real shared attribute
 *    (`REGION`, `ORDER_MONTH`), sometimes a coincidence;
 * 3. the same name once the key suffix is removed (`CUSTOMER_ID` beside
 *    `CUSTOMER_KEY`) — weaker, and the one most worth a second look.
 *
 * Deliberately NOT suggested: a match between differently-named columns
 * (`CUSTOMER_ID` and `CLIENT_ID`). Nothing in the metadata connects them,
 * and guessing from a shared data type would produce noise that teaches
 * people to click past this list.
 */
export function suggestSharedDimensions(
  members: CompositeMember[],
  describes: Record<string, SemanticViewDetail | undefined>,
  existing: SharedDimension[] = [],
): Candidate[] {
  // What is already mapped, so a second run offers only what is left.
  const taken = new Set<string>();
  for (const shared of existing) {
    for (const [alias, binding] of Object.entries(shared.bindings)) {
      taken.add(`${alias.toLowerCase()}|${binding.table}.${binding.column}`.toUpperCase());
    }
  }

  const exact = new Map<string, Occurrence[]>();
  const loose = new Map<string, Occurrence[]>();

  for (const member of members) {
    const detail = describes[member.alias.toLowerCase()];
    if (!detail) continue;
    for (const field of detail.dimensions ?? []) {
      if (!field.table || !field.name) continue;
      const key = `${member.alias.toLowerCase()}|${field.table}.${field.name}`;
      if (taken.has(key.toUpperCase())) continue;
      const entry = { alias: member.alias, field };
      const push = (map: Map<string, Occurrence[]>, mapKey: string) => {
        const list = map.get(mapKey) ?? [];
        // One column per member per group: a name occurring on two tables
        // of the same view is ambiguous, and picking one silently is the
        // kind of guess this module exists not to make.
        if (!list.some((o) => o.alias === entry.alias)) list.push(entry);
        map.set(mapKey, list);
      };
      push(exact, normalise(field.name));
      push(loose, normalise(withoutKeySuffix(field.name)));
    }
  }

  const out: Candidate[] = [];
  const seen = new Set<string>();

  const emit = (group: Occurrence[], reason: string, score: number) => {
    if (group.length < 2) return;
    const signature = group
      .map((o) => `${o.alias}.${o.field.table}.${o.field.name}`)
      .sort()
      .join("|");
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push({
      name: prettyName(group[0].field.name),
      bindings: Object.fromEntries(
        group.map((o) => [o.alias, { table: o.field.table, column: o.field.name }]),
      ),
      reason,
      score,
    });
  };

  for (const group of exact.values()) {
    const key = group.some((o) => looksLikeKey(o.field.name));
    emit(
      group,
      key
        ? `Same key column in ${group.length} views`
        : `Same column name in ${group.length} views`,
      key ? 3 : 2,
    );
  }
  for (const group of loose.values()) {
    emit(group, `Similar key column in ${group.length} views`, 1);
  }

  // Most members first (a dimension all four views share is likelier to be
  // real than one two of them share), then strength, then alphabetical so
  // the list is stable between renders.
  return out.sort(
    (a, b) =>
      Object.keys(b.bindings).length - Object.keys(a.bindings).length ||
      b.score - a.score ||
      a.name.localeCompare(b.name),
  );
}

/** Tables in a view that carry dimensions, for the table dropdown. */
export function dimensionTables(detail: SemanticViewDetail | undefined): string[] {
  const seen: string[] = [];
  for (const field of detail?.dimensions ?? []) {
    if (field.table && !seen.includes(field.table)) seen.push(field.table);
  }
  return seen;
}

/** The dimension columns of one table, for the column dropdown. */
export function dimensionColumns(
  detail: SemanticViewDetail | undefined,
  table: string,
): string[] {
  return (detail?.dimensions ?? [])
    .filter((field) => field.table === table)
    .map((field) => field.name);
}
