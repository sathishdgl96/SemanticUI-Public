import type { FieldInfo, SemanticViewDetail } from "../api/types";

/**
 * What one table carries, and how it joins.
 *
 * The three field kinds are not cosmetic: a metric is already aggregated
 * by the model and a fact is row-level, and the server refuses to put
 * both in one query because they measure at different grains.
 */
export default function TableDetail({
  detail,
  table,
}: {
  detail: SemanticViewDetail;
  table: string | null;
}) {
  if (!table) {
    return <p className="tile-hint">Select a table to see its fields and joins.</p>;
  }

  const groups: { label: string; fields: FieldInfo[] }[] = [
    { label: "Dimensions", fields: detail.dimensions.filter((f) => f.table === table) },
    { label: "Metrics", fields: detail.metrics.filter((f) => f.table === table) },
    { label: "Facts", fields: detail.facts.filter((f) => f.table === table) },
  ].filter((group) => group.fields.length > 0);

  const joins = detail.relationships.filter(
    (r) => r.table === table || r.refTable === table,
  );

  return (
    <div className="model-detail">
      <h3 className="model-detail-title">{table}</h3>

      {groups.length === 0 && joins.length === 0 && (
        <p className="tile-hint">This table has no fields in the model.</p>
      )}

      {groups.map((group) => (
        <section key={group.label}>
          <h4 className="model-detail-group">{group.label}</h4>
          <ul className="model-detail-fields">
            {group.fields.map((field) => (
              <li key={field.name}>
                <span className="model-field-name">{field.name}</span>
                {field.dataType && (
                  <span className="model-field-type">{field.dataType}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {joins.length > 0 && (
        <section>
          <h4 className="model-detail-group">Joins</h4>
          <ul className="model-detail-fields">
            {joins.map((join) => {
              // Read from this table outwards, whichever end it sits on,
              // so the panel describes the table you selected rather than
              // making you work out which side you are looking at.
              const outgoing = join.table === table;
              const other = outgoing ? join.refTable : join.table;
              const near = outgoing ? join.foreignKey : join.refKey;
              const far = outgoing ? join.refKey : join.foreignKey;
              return (
                <li key={join.name} className="model-join">
                  <span>
                    {outgoing ? "many → one " : "one ← many "}
                    <strong>{other}</strong>
                  </span>
                  {(near?.length || far?.length) && (
                    <span className="model-join-keys">
                      {(near ?? []).join(", ")} = {(far ?? []).join(", ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
