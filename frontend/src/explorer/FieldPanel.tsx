import type { FieldInfo, SemanticViewDetail } from "../api/types";

export interface Selection {
  dimensions: string[];
  metrics: string[];
}

interface Props {
  detail: SemanticViewDetail;
  selection: Selection;
  onToggle: (kind: "dimensions" | "metrics", ref: string) => void;
  onRun: () => void;
  running: boolean;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FieldGroup({
  title, kind, fields, selection, onToggle,
}: {
  title: string;
  kind: "dimensions" | "metrics";
  fields: FieldInfo[];
  selection: Selection;
  onToggle: Props["onToggle"];
}) {
  return (
    <section>
      <h4>{title}</h4>
      {fields.map((field) => {
        const ref = refOf(field);
        return (
          <label key={ref} className="field-row">
            <input
              type="checkbox"
              checked={selection[kind].includes(ref)}
              onChange={() => onToggle(kind, ref)}
              aria-label={ref}
            />
            <span>{ref}</span>
            {field.dataType && <small>{field.dataType}</small>}
          </label>
        );
      })}
    </section>
  );
}

export default function FieldPanel({ detail, selection, onToggle, onRun, running }: Props) {
  const canRun = selection.dimensions.length + selection.metrics.length > 0;
  return (
    <aside className="field-panel">
      <FieldGroup
        title="Dimensions" kind="dimensions" fields={detail.dimensions}
        selection={selection} onToggle={onToggle}
      />
      <FieldGroup
        title="Metrics" kind="metrics" fields={detail.metrics}
        selection={selection} onToggle={onToggle}
      />
      <button onClick={onRun} disabled={!canRun || running}>
        {running ? "Running..." : "Run"}
      </button>
    </aside>
  );
}
