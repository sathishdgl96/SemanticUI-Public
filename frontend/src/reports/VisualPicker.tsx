import type { Visual } from "../api/types";
import { CATALOG, type VisualType } from "./catalog";

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

/** Switch a visual's type, carrying over what the new type can still hold.
 *  Returns the labels of any wells that had to be dropped so the UI can say so. */
export function changeVisualType(
  visual: Visual,
  nextType: VisualType,
): { visual: Visual; dropped: string[] } {
  if (visual.type === nextType) return { visual, dropped: [] };
  const from = CATALOG[visual.type as VisualType];
  const to = CATALOG[nextType];

  const wells: Record<string, string[]> = {};
  for (const well of to.wells) wells[well.key] = [];

  const dropped: string[] = [];
  for (const well of from.wells) {
    const refs = visual.wells[well.key] ?? [];
    if (refs.length === 0) continue;
    const target = to.wells.find((w) => w.key === well.key && w.kind === well.kind);
    if (!target) {
      dropped.push(well.label);
      continue;
    }
    wells[target.key] = target.max === null ? refs : refs.slice(0, target.max);
    if (target.max !== null && refs.length > target.max) dropped.push(well.label);
  }

  const options = Object.fromEntries(
    Object.entries(visual.options).filter(([key]) => to.options.includes(key)),
  );

  return { visual: { ...visual, type: nextType, wells, options }, dropped };
}
