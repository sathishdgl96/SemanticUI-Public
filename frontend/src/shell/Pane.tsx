import { useState } from "react";

/** A PowerBI-style side pane: titled, and collapsible to a labeled strip.
 *
 *  Collapse state is deliberately ephemeral React state, like PowerBI's own
 *  panes — a report never remembers which panes you had tucked away. */
export default function Pane({
  title,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  defaultCollapsed?: boolean;
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

  return (
    <section className="pane" aria-label={title}>
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
    </section>
  );
}
