import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

/** Narrow enough that the pane is still a pane, wide enough that a
 *  fully-qualified `SCHEMA_NAME.A_LONG_COLUMN_NAME` has somewhere to go. */
export const MIN_PANE = 180;
export const MAX_PANE = 640;
function clamp(width: number): number {
  return Math.max(MIN_PANE, Math.min(MAX_PANE, Math.round(width)));
}

/** Which edge of the pane the handle sits on. A pane against the left of
 *  the window grows as its RIGHT edge moves right; one against the right
 *  of the window grows as its LEFT edge moves left. The handle always
 *  reports separator movement (positive = rightwards); the edge is what
 *  turns that into a width. */
export type PaneEdge = "left" | "right";

/**
 * A pane the user can widen, remembered across visits.
 *
 * The width lives in localStorage rather than in the report or the
 * explore: how wide somebody keeps their field list is a fact about their
 * screen and their eyesight, not about the document, and saving it into
 * the document would push a change to everybody who opens it.
 */
export function useResizablePane(storageKey: string, initial: number, edge: PaneEdge = "right") {
  const sign = edge === "left" ? -1 : 1;
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return initial;
    // A stored value is read as untrusted: it survives across releases,
    // it is editable by hand, and NaN reaching a style attribute would
    // collapse the pane to nothing with no way back.
    const saved = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : initial;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // A full or blocked store must not stop the pane from resizing.
    }
  }, [storageKey, width]);

  const drag = useRef<{ from: number; startWidth: number } | null>(null);
  // The latest width, readable from inside a listener that was attached
  // before it changed.
  const latest = useRef(width);
  latest.current = width;

  const beginResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    // What is on screen, in case a stylesheet has had the last word on the
    // pane's width; the state is the fallback when nothing is laid out.
    const measured = event.currentTarget.parentElement?.getBoundingClientRect().width;
    drag.current = { from: event.clientX, startWidth: measured || latest.current };

    // Window-level, not element-level: the pointer leaves the 6px handle
    // almost immediately, and a listener on the handle would stop
    // tracking the moment it did.
    const move = (moved: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      setWidth(clamp(state.startWidth + sign * (moved.clientX - state.from)));
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
  }, [sign]);

  /** Move the separator `by` pixels rightwards (negative: leftwards). */
  const nudge = useCallback((by: number) => {
    setWidth((current) => clamp(current + sign * by));
  }, [sign]);

  const reset = useCallback(() => setWidth(initial), [initial]);

  return { width, beginResize, nudge, reset };
}
