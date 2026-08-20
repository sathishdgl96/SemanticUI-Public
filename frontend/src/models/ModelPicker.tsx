import { useQuery } from "@tanstack/react-query";
import { listComposites } from "../api/composites";

/** A source a report or an explore can sit on: one semantic view, or a
 *  model over several. `compositeId` is what tells them apart. */
export interface BindSource {
  database: string;
  schema: string;
  name: string;
  comment?: string | null;
  compositeId?: string;
}

/**
 * The models this user can build on, beside the semantic-view tree.
 *
 * Its own list rather than a fourth branch of that tree: a model does not
 * live in a database and a schema, and inventing a place for it there
 * would be a lie about where it comes from. It comes from a workspace,
 * which is what this shows.
 */
export default function ModelPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (source: BindSource) => void;
}) {
  const models = useQuery({
    queryKey: ["composites"],
    queryFn: () => listComposites(),
  });

  const rows = (models.data?.composites ?? []).filter(
    // A model with nothing mapped cannot answer anything, and offering it
    // would hand somebody an empty field list with no way to tell why.
    (model) => model.memberCount > 0,
  );

  if (models.isLoading) return <p className="tile-hint">Loading models…</p>;
  if (rows.length === 0) return null;

  return (
    <nav className="view-tree model-picker-tree">
      <h3>Models</h3>
      <p className="tile-hint">Over several semantic views.</p>
      <ul>
        {rows.map((model) => (
          <li key={model.id}>
            <button
              type="button"
              className={selected === model.id ? "is-selected" : undefined}
              onClick={() =>
                onSelect({
                  database: "",
                  schema: "",
                  name: model.name,
                  comment: null,
                  compositeId: model.id,
                })
              }
            >
              {model.name}
              <span className="view-tree-note">
                {model.memberCount === 1
                  ? "1 view"
                  : `${model.memberCount} views`}
                {model.workspaceName ? ` · ${model.workspaceName}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
