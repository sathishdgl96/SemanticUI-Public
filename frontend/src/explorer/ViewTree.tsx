import type { SemanticViewSummary } from "../api/types";
import { groupViews } from "./groupViews";

interface Props {
  views: SemanticViewSummary[];
  selected: SemanticViewSummary | null;
  onSelect: (view: SemanticViewSummary) => void;
}

export default function ViewTree({ views, selected, onSelect }: Props) {
  const grouped = groupViews(views);
  return (
    <nav className="view-tree">
      {Object.entries(grouped).map(([database, schemas]) => (
        <div key={database}>
          <h3>{database}</h3>
          {Object.entries(schemas).map(([schema, schemaViews]) => (
            <div key={schema} className="schema-group">
              <h4>{schema}</h4>
              <ul>
                {schemaViews.map((view) => (
                  <li key={view.name}>
                    <button
                      className={
                        selected?.name === view.name &&
                        selected?.database === view.database &&
                        selected?.schema === view.schema
                          ? "view-item selected"
                          : "view-item"
                      }
                      onClick={() => onSelect(view)}
                      title={view.comment ?? undefined}
                    >
                      {view.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
