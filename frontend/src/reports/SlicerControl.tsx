import type { ViewRef, Visual } from "../api/types";
import { useFieldValues } from "./useFieldValues";

interface Props {
  visual: Visual;
  view: ViewRef;
  /** Values currently ticked on this slicer's field. */
  selected: string[];
  onChange: (field: string, values: string[]) => void;
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

/** A slicer: the on-canvas way to filter, and the control PowerBI users reach
 *  for before they ever open the filter pane.
 *
 *  Its selection is EPHEMERAL -- held in the builder alongside drill and
 *  cross-filter state, never written to the definition. That is what lets a
 *  viewer, who cannot save, still slice a shared report; a slicer that wrote
 *  to the definition would be a control they are forbidden to touch. */
export default function SlicerControl({ visual, view, selected, onChange }: Props) {
  const ref = (visual.wells.field ?? [])[0];
  const values = useFieldValues(view, ref ?? null);
  const multi = visual.options.multiSelect !== false;

  if (!ref) return <p className="tile-hint">Add a field to slice by.</p>;
  if (values.isLoading) return <p className="tile-hint">Loading values…</p>;
  if (values.isError) {
    return (
      <p role="alert" className="tile-error">
        Could not load values for {fieldName(ref)}.
      </p>
    );
  }

  const options = values.data?.values ?? [];
  const toggle = (value: string, checked: boolean) => {
    if (!multi) {
      onChange(ref, checked ? [value] : []);
      return;
    }
    onChange(
      ref,
      checked ? [...selected, value] : selected.filter((v) => v !== value),
    );
  };

  return (
    <div className="slicer">
      <div className="slicer-head">
        {selected.length > 0 && (
          <button
            type="button"
            className="link"
            onClick={() => onChange(ref, [])}
            aria-label={`Clear ${fieldName(ref)} slicer`}
          >
            Clear
          </button>
        )}
      </div>
      <ul className="slicer-values">
        {options.map((value) => (
          <li key={value}>
            <label>
              <input
                type={multi ? "checkbox" : "radio"}
                name={`slicer-${visual.id}`}
                checked={selected.includes(value)}
                onChange={(e) => toggle(value, e.target.checked)}
              />
              <span>{value}</span>
            </label>
          </li>
        ))}
      </ul>
      {values.data?.truncated && (
        <p className="tile-hint">Showing the first {options.length} values.</p>
      )}
    </div>
  );
}
