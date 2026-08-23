import type { Visual } from "../api/types";
import { CATALOG, type FieldKind, type VisualType } from "./catalog";

interface Props {
  value: VisualType;
  onChange: (next: VisualType) => void;
}

export default function VisualPicker({ value, onChange }: Props) {
  return (
    <div className="visual-picker" role="group" aria-label="Visual type">
      {(Object.keys(CATALOG) as VisualType[]).map((type) => {
        const spec = CATALOG[type];
        return (
          <button
            key={type}
            type="button"
            className={type === value ? "picker-item selected" : "picker-item"}
            aria-pressed={type === value}
            aria-label={spec.label}
            title={spec.label}
            onClick={() => onChange(type)}
          >
            <span aria-hidden="true">{spec.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Switch a visual's type, carrying the fields over.
 *
 *  Matching is by KIND and position, not by well key. Keying on the name was
 *  the old behaviour and it silently emptied the visual on most switches: no
 *  chart type shares "axis" with `table` (which calls it "dimensions") or with
 *  `kpi` (which has only "value"), so bar → table dropped every field the user
 *  had placed. PowerBI refills the new type's wells from what you already had,
 *  and so does this: dimensions go to dimension wells and metrics to metric
 *  wells, in catalog order, each taking as many as it accepts.
 *
 *  Returns the refs that genuinely had nowhere to go, so the UI can name what
 *  was lost rather than claiming a well label the user never sees. */
export function changeVisualType(
  visual: Visual,
  nextType: VisualType,
): { visual: Visual; dropped: string[] } {
  if (visual.type === nextType) return { visual, dropped: [] };
  const from = CATALOG[visual.type as VisualType];
  const to = CATALOG[nextType];

  // Read the outgoing wells in catalog order so the field the user thought of
  // as "first" stays first -- an axis field must not arrive behind a legend one.
  const queue: Record<FieldKind, string[]> = { dimension: [], metric: [] };
  for (const well of from.wells) {
    for (const ref of visual.wells[well.key] ?? []) {
      if (!queue[well.kind].includes(ref)) queue[well.kind].push(ref);
    }
  }

  const wells: Record<string, string[]> = {};
  for (const well of to.wells) {
    const room = well.max === null ? queue[well.kind].length : well.max;
    wells[well.key] = queue[well.kind].splice(0, room);
  }

  // Whatever is still queued had no well of its kind with room left.
  const dropped = [...queue.dimension, ...queue.metric];

  const options = Object.fromEntries(
    Object.entries(visual.options).filter(([key]) => to.options.includes(key)),
  );

  return { visual: { ...visual, type: nextType, wells, options }, dropped };
}
