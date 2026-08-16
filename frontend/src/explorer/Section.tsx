/** A collapsible band in the explorer's right-hand column.
 *
 *  Filters, Visualization and Data are stacked rather than side by side, and
 *  each can be folded away. That layout is not decoration: it is what lets
 *  the field picker sit hard against the left edge with everything else to
 *  its right, instead of competing with three more columns for width.
 */

import { useId, useState, type ReactNode } from "react";

interface Props {
  title: string;
  /** Shown next to the title — a count, a row total, a chosen type. */
  summary?: ReactNode;
  /** Controls that belong to the section, kept in its header so they stay
   *  reachable when the body is folded away. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function Section({
  title, summary, actions, defaultOpen = true, children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="explore-section" data-open={open}>
      <header className="explore-section-head">
        <button
          type="button"
          className="explore-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          {title}
        </button>
        {summary && <span className="explore-section-summary">{summary}</span>}
        {actions && <span className="explore-section-actions">{actions}</span>}
      </header>
      {open && (
        <div className="explore-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
