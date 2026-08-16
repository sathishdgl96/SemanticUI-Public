import type { ViewRef, Visual } from "../api/types";
import ValuePicker from "./ValuePicker";

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
  const multi = visual.options.multiSelect !== false;

  if (!ref) return <p className="tile-hint">Add a field to slice by.</p>;

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
      {/* The same picker the filter pane uses. A slicer listing a thousand
          values was a tile you could not see past; it now shows ten and
          searches for the rest. */}
      <ValuePicker
        view={view}
        field={ref}
        selected={selected}
        onChange={(next) => onChange(ref, next)}
        multi={multi}
        groupName={`slicer-${visual.id}`}
      />
    </div>
  );
}
