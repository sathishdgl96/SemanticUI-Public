/** A small ⓘ that explains something on request.
 *
 *  For text that is worth having available and not worth spending three lines
 *  of a pane on every time. The filter pane had a sentence under each of its
 *  three scopes explaining what that scope meant -- useful exactly once, and
 *  then permanently in the way of the filters themselves.
 *
 *  Click, not hover: a hover tooltip is unreachable by touch and awkward by
 *  keyboard, and this is the only place the explanation exists.
 */

import { useId, useState, type ReactNode } from "react";

interface Props {
  /** What the button is called to a screen reader, e.g. "About this scope". */
  label: string;
  children: ReactNode;
}

export default function InfoTip({ label, children }: Props) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <span className="info-tip-body" id={bodyId} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
