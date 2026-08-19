/** The builder's drop rules, as one pure decision. `resolveDrop` reads a
 *  dnd-kit event and answers with the visual to replace or the filter to
 *  add; the component only dispatches. Keeping every branch here means the
 *  chip/filter/well precedence can be read (and tested) in one place. */

import type { DragEndEvent } from "@dnd-kit/core";
import type { Visual } from "../../api/types";
import { CATALOG, type FieldKind, type VisualType } from "../catalog";
import { PAGE_DROP_ID, REPORT_DROP_ID, VISUAL_DROP_ID } from "../FilterPane";
import { moveWellRef } from "../wellOrder";

export type FilterScope = "report" | "page" | "visual";

export type DropOutcome =
  | { kind: "replaceVisual"; visual: Visual }
  | { kind: "addFilter"; scope: FilterScope; ref: string }
  | null;

export function resolveDrop(event: DragEndEvent, visual: Visual | null): DropOutcome {
  const overId = String(event.over?.id ?? "");
  const data = event.active.data.current as
    | { ref: string; kind: FieldKind; fromWell?: string; chip?: boolean }
    | undefined;

  // A chip drag rearranges: within its well (nesting order is meaning,
  // not cosmetics -- in a matrix it IS the drill order), or into another
  // well of the same kind. Chips never create filters or duplicates, so
  // this branch owns them entirely.
  if (data?.chip && data.fromWell && visual) {
    if (overId.startsWith("chipdrop:")) {
      const rest = overId.slice("chipdrop:".length);
      const [toWell, beforeRef] = [
        rest.slice(0, rest.indexOf(":")),
        rest.slice(rest.indexOf(":") + 1),
      ];
      return {
        kind: "replaceVisual",
        visual: moveWellRef(visual, data.fromWell, data.ref, toWell, beforeRef),
      };
    }
    if (overId.startsWith("well:")) {
      return {
        kind: "replaceVisual",
        visual: moveWellRef(visual, data.fromWell, data.ref, overId.slice("well:".length)),
      };
    }
    return null;
  }
  // Filter scopes first: the well branch below returns early for any id it
  // does not recognise, so it would swallow these.
  const scope =
    overId === REPORT_DROP_ID
      ? "report"
      : overId === PAGE_DROP_ID
        ? "page"
        : overId === VISUAL_DROP_ID
          ? "visual"
          : null;
  if (data && scope) {
    return { kind: "addFilter", scope, ref: data.ref };
  }
  if (!visual || !data || !overId.startsWith("well:")) return null;
  const key = overId.slice("well:".length);
  const spec = CATALOG[visual.type as VisualType].wells.find((w) => w.key === key);
  if (!spec || spec.kind !== data.kind) return null; // wrong kind: refuse
  const current = visual.wells[key] ?? [];
  if (current.includes(data.ref)) return null; // already there
  if (Object.values(visual.wells).some((refs) => refs.includes(data.ref))) return null; // another well
  const next = spec.max === 1 ? [data.ref] : [...current, data.ref];
  return {
    kind: "replaceVisual",
    visual: { ...visual, wells: { ...visual.wells, [key]: next } },
  };
}
