import { MAX_PANE, MIN_PANE, type PaneEdge } from "./useResizablePane";

/** One arrow press. Small enough to place an edge precisely, large
 *  enough that crossing the pane does not take a hundred of them. */
const STEP = 16;

/**
 * The grab handle on a pane's edge.
 *
 * A separator, and a real one: `role="separator"` with `aria-valuenow`, so
 * a screen reader announces it as something adjustable rather than as a
 * decorative sliver. Arrow keys move it, because a pointer drag is not
 * available to everybody and a pane nobody can widen was the problem this
 * solves.
 */
export default function PaneResizer({
  label,
  width,
  edge = "right",
  onBegin,
  onNudge,
  onReset,
}: {
  label: string;
  width: number;
  /** The pane edge the handle sits on. Arrow keys always move the handle
   *  itself -- left is left -- and the hook works out what that does to
   *  the width. */
  edge?: PaneEdge;
  onBegin: (event: React.PointerEvent) => void;
  onNudge: (by: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={MIN_PANE}
      aria-valuemax={MAX_PANE}
      tabIndex={0}
      className={edge === "left" ? "pane-resizer pane-resizer-left" : "pane-resizer"}
      title="Drag to resize · double-click to reset"
      onPointerDown={onBegin}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-STEP);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(STEP);
        } else if (event.key === "Home") {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
