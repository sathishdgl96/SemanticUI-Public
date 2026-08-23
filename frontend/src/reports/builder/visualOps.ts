/** Pure visual transforms: minting a visual at the bottom of a page, adding
 *  a field to the right well, removing one everywhere. The dedupe and
 *  full-well rules live here so the click path and the drop path cannot
 *  drift apart. */

import type { AskSpec, Page, Visual } from "../../api/types";
import { defaultWellFor, emptyWellsFor, type FieldKind, type VisualType } from "../catalog";

/** New visuals land below everything already on the page. */
function nextRowY(page: Page): number {
  return page.visuals.reduce((max, v) => Math.max(max, v.layout.y + v.layout.h), 0);
}

export function mintVisual(
  page: Page,
  type: VisualType,
  overrides: Partial<Omit<Visual, "id" | "layout">> = {},
): Visual {
  return {
    id: `v${crypto.randomUUID().slice(0, 8)}`,
    type,
    title: "",
    layout: { x: 0, y: nextRowY(page), w: 6, h: 6 },
    wells: emptyWellsFor(type),
    options: {},
    filters: [],
    ...overrides,
  };
}

/** The wells a brand-new visual carries when a checkbox tick creates it. */
export function wellsWithField(
  type: VisualType,
  kind: FieldKind,
  ref: string,
): Visual["wells"] {
  const wells = emptyWellsFor(type);
  const wellKey = defaultWellFor(type, kind, wells);
  if (wellKey) wells[wellKey] = [ref];
  return wells;
}

/** Pin an answer onto the canvas. The spec already speaks the well
 *  vocabulary, so this is a re-shaping rather than a translation. */
export function visualFromSpec(page: Page, spec: AskSpec): Visual {
  return mintVisual(page, "bar", {
    title: spec.explanation.slice(0, 200),
    wells: {
      ...emptyWellsFor("bar"),
      axis: spec.dimensions.slice(0, 1),
      values: spec.metrics,
    },
    // The answer's filters travel with it, or the pinned tile would show a
    // different number from the one that was just on screen.
    filters: spec.filters,
  });
}

/** Un-check: the field leaves every well it sits in. */
export function removeFieldEverywhere(visual: Visual, ref: string): Visual {
  return {
    ...visual,
    wells: Object.fromEntries(
      Object.entries(visual.wells).map(([key, refs]) => [
        key,
        refs.filter((r) => r !== ref),
      ]),
    ),
  };
}

export type AddFieldResult = { visual: Visual } | { notice: string } | null;

/** Add a field to a visual's default well for its kind. A ref already
 *  sitting in ANY well is a no-op (null), not another append — otherwise
 *  clicking the same field row repeatedly kept stacking duplicates into an
 *  unbounded well (e.g. Values). */
export function addField(visual: Visual, ref: string, kind: FieldKind): AddFieldResult {
  if (Object.values(visual.wells).some((refs) => refs.includes(ref))) return null;
  const wellKey = defaultWellFor(visual.type as VisualType, kind, visual.wells);
  if (!wellKey) {
    return { notice: `Every ${kind} well on this visual is full.` };
  }
  return {
    visual: {
      ...visual,
      wells: { ...visual.wells, [wellKey]: [...(visual.wells[wellKey] ?? []), ref] },
    },
  };
}
