import { useState } from "react";
import PaneResizer from "../ui/PaneResizer";
import type { useResizablePane } from "../ui/useResizablePane";

/** A PowerBI-style side pane: titled, and collapsible to a labeled strip.
 *
 *  Collapse state is deliberately ephemeral React state, like PowerBI's own
 *  panes — a report never remembers which panes you had tucked away. The
 *  width, when the pane has one, is the opposite: it is remembered, by the
 *  hook that owns it (see useResizablePane). */
export default function Pane({
  title,
  defaultCollapsed = false,
  resize,
  children,
}: {
  title: string;
  defaultCollapsed?: boolean;
  /** A `useResizablePane(..., "left")` result. The rail hangs off the right
   *  of the window, so a pane in it grows leftwards. Absent, the pane is
   *  the stylesheet's fixed width. */
  resize?: ReturnType<typeof useResizablePane>;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (collapsed) {
    return (
      <button
        type="button"
        className="pane-strip"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        aria-label={`Expand ${title}`}
      >
        <span className="pane-strip-label">{title}</span>
        <span aria-hidden="true">«</span>
      </button>
    );
  }

  // Both width AND flex-basis: the pane is a flex item whose stylesheet
  // basis would otherwise win over an inline width.
  const style = resize ? { width: resize.width, flexBasis: resize.width } : undefined;

  return (
    <section className="pane" aria-label={title} style={style}>
      <header className="pane-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="pane-collapse"
          onClick={() => setCollapsed(true)}
          aria-expanded
          aria-label={`Collapse ${title}`}
        >
          »
        </button>
      </header>
      <div className="pane-body">{children}</div>
      {resize && (
        <PaneResizer
          label={`Resize ${title}`}
          width={resize.width}
          edge="left"
          onBegin={resize.beginResize}
          onNudge={resize.nudge}
          onReset={resize.reset}
        />
      )}
    </section>
  );
}
