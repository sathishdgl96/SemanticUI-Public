import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import CloseButton from "./CloseButton";

interface Props {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Whatever opened the dialog. Focus goes back there on close, because a
   *  keyboard user who opens a dialog from the profile menu and closes it
   *  should be back at the profile menu, not at the top of the document. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/** Focusable descendants, in tab order. `:not([disabled])` matters: a
 *  disabled control is in the DOM and not in the cycle, and wrapping onto one
 *  looks to the user like Tab did nothing. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * A modal dialog: labelled, focus-trapped, and dismissible.
 *
 * Content-agnostic on purpose. This primitive will outlive whichever feature
 * needed it first, and if it knows what a welcome is then the next dialog
 * cannot reuse it.
 *
 * The trap is not decoration. A modal is the one component that can strand a
 * keyboard user with no way out, so Tab cycles within and Escape always
 * leaves.
 */
export default function Dialog({ title, children, onClose, returnFocusTo }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    // Both captured on open, not read on close: by cleanup the trigger may
    // already have unmounted, and focusing a detached node silently does
    // nothing -- which looks exactly like a working focus trap that isn't.
    const previous = document.activeElement as HTMLElement | null;
    const explicit = returnFocusTo?.current ?? null;
    // The panel itself takes focus first rather than the first control: a
    // dialog that opens with a button already focused reads to a screen
    // reader as that button, not as the dialog.
    panel.current?.focus();

    return () => {
      (explicit ?? previous)?.focus?.();
    };
  }, [returnFocusTo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;

      const stops = Array.from(
        panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (stops.length === 0) {
        // Nothing to move to, so Tab must not escape to the page behind.
        event.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="dialog-scrim" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={panel}
        // The scrim closes on click; the panel must not inherit that.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 id={headingId}>{title}</h2>
          <CloseButton onClick={onClose} label={`Close ${title}`} />
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
