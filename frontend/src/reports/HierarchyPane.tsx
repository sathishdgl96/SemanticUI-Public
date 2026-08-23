import type { FieldInfo, Hierarchy } from "../api/types";

/** Model-declared hierarchies carry this id prefix (see detect_hierarchies).
 *  They belong to the semantic view, not the report, so they are listed but
 *  never editable here. */
const MODEL_PREFIX = "model:";

interface Props {
  hierarchies: Hierarchy[];
  dimensions: FieldInfo[];
  onChange: (next: Hierarchy[]) => void;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

export default function HierarchyPane({ hierarchies, dimensions, onChange }: Props) {
  const replace = (index: number, next: Hierarchy) =>
    onChange(hierarchies.map((h, i) => (i === index ? next : h)));

  return (
    <section className="hierarchy-pane">
      <h3>Hierarchies</h3>
      {hierarchies.length === 0 && (
        <p className="tile-hint">
          No hierarchies yet. Build one to let a visual drill from a broad level to a
          narrow one.
        </p>
      )}
      {hierarchies.map((hierarchy, index) => {
        const fromModel = hierarchy.id.startsWith(MODEL_PREFIX);
        const used = new Set(hierarchy.levels);
        const available = dimensions.filter((d) => !used.has(refOf(d)));

        if (fromModel) {
          return (
            <div key={hierarchy.id} className="hierarchy">
              <div className="hierarchy-head">
                <strong>{hierarchy.name}</strong>
              </div>
              <ol className="hierarchy-levels">
                {hierarchy.levels.map((level) => (
                  <li key={level}>
                    <span>{level}</span>
                  </li>
                ))}
              </ol>
              <p className="tile-hint">
                Defined by the semantic model, so it cannot be changed here.
              </p>
            </div>
          );
        }

        return (
          <div key={hierarchy.id} className="hierarchy">
            <div className="hierarchy-head">
              <input
                aria-label={`Hierarchy name for ${hierarchy.name}`}
                value={hierarchy.name}
                onChange={(e) => replace(index, { ...hierarchy, name: e.target.value })}
              />
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Delete ${hierarchy.name}`}
                title={`Delete ${hierarchy.name}`}
                onClick={() => onChange(hierarchies.filter((_, i) => i !== index))}
              >
                <span aria-hidden="true">🗑</span>
              </button>
            </div>
            <ol className="hierarchy-levels">
              {hierarchy.levels.map((level) => (
                <li key={level}>
                  <span>{level}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      replace(index, {
                        ...hierarchy,
                        levels: hierarchy.levels.filter((l) => l !== level),
                      })
                    }
                  >
                    Remove {level}
                  </button>
                </li>
              ))}
            </ol>
            {hierarchy.levels.length < 2 && (
              // The server rejects this on save; saying so inline turns a 400
              // into a hint you can act on before you hit Save.
              <p className="tile-hint">
                A hierarchy needs at least two levels — one level is just a field.
              </p>
            )}
            <label>
              Add a level to {hierarchy.name}
              <select
                value=""
                disabled={available.length === 0}
                onChange={(e) =>
                  e.target.value &&
                  replace(index, {
                    ...hierarchy,
                    levels: [...hierarchy.levels, e.target.value],
                  })
                }
              >
                <option value="">Choose a dimension…</option>
                {available.map((d) => (
                  <option key={refOf(d)} value={refOf(d)}>
                    {refOf(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onChange([
            ...hierarchies,
            {
              id: `h${crypto.randomUUID().slice(0, 8)}`,
              name: "New hierarchy",
              levels: [],
            },
          ])
        }
      >
        New hierarchy
      </button>
    </section>
  );
}
