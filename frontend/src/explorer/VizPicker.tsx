/** The row of visualisation types, as Looker puts above a chart.
 *
 *  Every type the report catalog knows except the slicer. A type the current
 *  selection cannot draw is shown disabled rather than hidden, so the gallery
 *  is a stable thing you learn the shape of rather than a list that changes
 *  length under you.
 */

import { CATALOG, type VisualType } from "../reports/catalog";
import { canRender, EXPLORE_VISUALS } from "./vizTypes";
import type { Wells } from "./wells";

interface Props {
  wells: Wells;
  active: VisualType;
  onPick: (type: VisualType) => void;
}

export default function VizPicker({ wells, active, onPick }: Props) {
  return (
    <div className="viz-picker" role="group" aria-label="Visualisation type">
      {EXPLORE_VISUALS.map((type) => {
        const usable = canRender(type, wells);
        return (
          <button
            key={type}
            type="button"
            className="viz-choice"
            aria-pressed={type === active}
            disabled={!usable}
            title={
              usable
                ? CATALOG[type].label
                : `${CATALOG[type].label} — not possible with the fields selected`
            }
            onClick={() => onPick(type)}
          >
            <span className="viz-glyph" aria-hidden="true">{CATALOG[type].glyph}</span>
            <span className="sr-only">{CATALOG[type].label}</span>
          </button>
        );
      })}
    </div>
  );
}
