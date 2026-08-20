/** Column widths a reader chose, and the column they sorted by.
 *
 *  Kept out of the page so both can be exercised without rendering one --
 *  a drag is awkward to drive in a test, and the arithmetic it performs is
 *  the part worth being sure of.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SortKey = "name" | "kind" | "detail" | "role" | "updated" | "recent";
export type SortDirection = "asc" | "desc";

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/** The shape the comparator reads. The page's row type satisfies it; the
 *  comparator does not need to know what else is on the row. */
export interface SortableRow {
  name: string;
  kind: string;
  detail: string;
  myRole: string;
  updatedAt: string;
  lastViewedAt: string | null;
}

/** Which way a column sorts when you first click it. Text reads forwards;
 *  a date reads newest-first, because "sort by Modified" almost always
 *  means "what changed lately". */
const NATURAL: Record<SortKey, SortDirection> = {
  name: "asc",
  kind: "asc",
  detail: "asc",
  role: "asc",
  updated: "desc",
  recent: "desc",
};

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, direction: NATURAL[key] };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function valueOf(row: SortableRow, key: SortKey): string {
  switch (key) {
    case "name":
      return row.name;
    case "kind":
      return row.kind;
    case "detail":
      return row.detail;
    case "role":
      return row.myRole;
    case "updated":
      return row.updatedAt;
    case "recent":
      return row.lastViewedAt ?? "";
  }
}

/**
 * Order two rows.
 *
 * Blanks sort last whichever way the column is pointing -- never opened,
 * or never bound to a view, is an absence rather than the smallest
 * possible value, and letting the empty string win an ascending sort puts
 * every gap at the top of the list.
 */
export function compareRows(a: SortableRow, b: SortableRow, sort: SortState): number {
  const left = valueOf(a, sort.key);
  const right = valueOf(b, sort.key);
  if (!left && !right) return a.name.localeCompare(b.name);
  if (!left) return 1;
  if (!right) return -1;
  const order = left.localeCompare(right, undefined, { numeric: true });
  const directed = sort.direction === "asc" ? order : -order;
  // Ties break by name, so the list does not reshuffle between renders
  // when several rows share a role or a kind.
  return directed !== 0 ? directed : a.name.localeCompare(b.name);
}

export function sortRows<T extends SortableRow>(rows: T[], sort: SortState): T[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort));
}

// --- widths ----------------------------------------------------------------

export type Widths = Record<string, number>;

/** Narrower than this and a column is a sliver with an ellipsis in it. */
export const MIN_COLUMN = 60;

function read(storageKey: string): Widths {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    // Only numbers, only sane ones: this is user-writable storage, and a
    // string or a NaN in here would reach a style attribute.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0,
      ),
    ) as Widths;
  } catch {
    // Private browsing, a quota, or a half-written value. A default
    // layout is a fine answer; a crashed page is not.
    return {};
  }
}

/**
 * Column widths, remembered across visits.
 *
 * Per browser rather than per user on the server: a column width is a
 * property of the screen you are looking at, and the same person at a
 * laptop and a desk monitor wants different ones.
 */
export function useTableColumns(storageKey: string) {
  const [widths, setWidths] = useState<Widths>(() => read(storageKey));
  const drag = useRef<{ key: string; from: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Not being able to remember a column width is not worth an error.
    }
  }, [storageKey, widths]);

  const resize = useCallback((key: string, width: number) => {
    setWidths((current) => ({ ...current, [key]: Math.max(MIN_COLUMN, Math.round(width)) }));
  }, []);

  const reset = useCallback((key: string) => {
    setWidths((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  /** Begin a drag. Listeners go on the window, not the grip: the pointer
   *  leaves a 6px handle immediately and a drag that stops the moment it
   *  does is not a drag. */
  const beginResize = useCallback(
    (event: React.PointerEvent, key: string, startWidth: number) => {
      event.preventDefault();
      event.stopPropagation();
      drag.current = { key, from: event.clientX, startWidth };

      const move = (moved: PointerEvent) => {
        const state = drag.current;
        if (!state) return;
        setWidths((current) => ({
          ...current,
          [state.key]: Math.max(
            MIN_COLUMN,
            Math.round(state.startWidth + moved.clientX - state.from),
          ),
        }));
      };
      const stop = () => {
        drag.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [],
  );

  return { widths, resize, reset, beginResize };
}
