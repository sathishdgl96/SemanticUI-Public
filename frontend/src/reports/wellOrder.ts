import type { Visual } from "../api/types";
import { CATALOG, type VisualType } from "./catalog";

/** Move `ref` out of `fromWell` and into `toWell`, in front of `beforeRef`
 *  (or to the end when absent). Same-well moves reorder; cross-well moves
 *  relocate the field, exactly what dragging a chip between Rows and
 *  Columns should mean. Returns the visual unchanged when the move is
 *  not allowed -- wrong field kind for the target, or a full well. */
export function moveWellRef(
  visual: Visual,
  fromWell: string,
  ref: string,
  toWell: string,
  beforeRef?: string,
): Visual {
  const spec = CATALOG[visual.type as VisualType];
  const from = spec.wells.find((w) => w.key === fromWell);
  const to = spec.wells.find((w) => w.key === toWell);
  if (!from || !to) return visual;
  const source = visual.wells[fromWell] ?? [];
  if (!source.includes(ref)) return visual;
  if (from.kind !== to.kind) return visual;

  const target = fromWell === toWell ? source : (visual.wells[toWell] ?? []);
  if (fromWell !== toWell && to.max !== null && target.length >= to.max) {
    return visual;
  }

  const withoutRef = target.filter((r) => r !== ref);
  const at = beforeRef ? withoutRef.indexOf(beforeRef) : -1;
  const next = [...withoutRef];
  next.splice(at >= 0 ? at : next.length, 0, ref);

  if (fromWell === toWell) {
    return { ...visual, wells: { ...visual.wells, [fromWell]: next } };
  }
  return {
    ...visual,
    wells: {
      ...visual.wells,
      [fromWell]: source.filter((r) => r !== ref),
      [toWell]: next,
    },
  };
}
