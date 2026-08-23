import { useMemo } from "react";
import type { SemanticViewDetail } from "../api/types";
import {
  relatedFields,
  type FieldRelation,
  type JoinStep,
  type Link,
} from "./relatedness";

/** The one-line answer to "how does this table connect to that one". */
function describe(link: Link): string {
  const hops = (n: number) => `${n} join${n === 1 ? "" : "s"} away`;
  switch (link.kind) {
    case "same":
      return "Same table";
    case "downstream":
      return `${hops(link.path.length)} — this table references it`;
    case "upstream":
      return `${hops(link.path.length)} — it references this table`;
    case "bridged":
      return `Only joined through ${link.through}`;
    case "none":
      return "No join path";
  }
}

function stepsOf(link: Link): JoinStep[] {
  if (link.kind === "downstream" || link.kind === "upstream") return link.path;
  if (link.kind === "bridged") return [...link.path, ...link.otherPath];
  return [];
}

function Path({ steps }: { steps: JoinStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="model-path">
      {steps.map((step) => (
        <li key={`${step.relationship}:${step.from}:${step.to}`}>
          <span className="model-path-ends">
            {step.from} → {step.to}
          </span>
          {step.on ? (
            <span className="model-path-on">{step.on}</span>
          ) : (
            <span className="model-path-on muted">join columns not reported</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Everything a selected field relates to, grouped by the table it lives in.
 *
 * Two facts per table, and they are different questions: how the tables
 * are joined, and whether the fields can be put in one query. A dimension
 * three joins away is still perfectly askable; a metric one join away may
 * not be, because a measure fixes the base entity. Saying only the first
 * would be the more flattering diagram and the less useful one.
 */
export default function FieldRelations({
  detail,
  field,
  onSelect,
  onClear,
}: {
  detail: SemanticViewDetail;
  field: string;
  onSelect: (ref: string) => void;
  onClear: () => void;
}) {
  const relations = useMemo(() => relatedFields(detail, field), [detail, field]);
  const [table, name] = field.split(".");

  const byTable = useMemo(() => {
    const groups = new Map<string, FieldRelation[]>();
    for (const relation of relations) {
      groups.set(relation.table, [...(groups.get(relation.table) ?? []), relation]);
    }
    return [...groups.entries()];
  }, [relations]);

  const blocked = relations.filter((r) => !r.together.ok).length;

  return (
    <div className="model-detail">
      <div className="model-detail-head">
        <h3 className="model-detail-title">
          <span className="model-detail-table">{table}</span>
          {name}
        </h3>
        <button type="button" className="link-button" onClick={onClear}>
          Clear
        </button>
      </div>

      <p className="model-detail-summary">
        Reaches {relations.length - blocked} of {relations.length} other fields
        {blocked > 0 && <> · {blocked} cannot be asked alongside it</>}
      </p>

      {byTable.length === 0 && (
        <p className="tile-hint">This model has no other fields.</p>
      )}

      {byTable.map(([other, fields]) => {
        const link = fields[0].link;
        return (
          <section key={other} className={`model-relation link-${link.kind}`}>
            <h4 className="model-detail-group">
              {other}
              <span className="model-relation-how">{describe(link)}</span>
            </h4>
            <Path steps={stepsOf(link)} />
            <ul className="model-detail-fields">
              {fields.map((relation) => (
                <li key={relation.ref} className={relation.together.ok ? "" : "blocked"}>
                  <button
                    type="button"
                    className="model-field-button"
                    onClick={() => onSelect(relation.ref)}
                  >
                    <span className={`model-field-name kind-${relation.kind}`}>
                      {relation.name}
                    </span>
                    {relation.dataType && (
                      <span className="model-field-type">{relation.dataType}</span>
                    )}
                  </button>
                  {!relation.together.ok && (
                    <span className="model-field-blocked">{relation.together.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
