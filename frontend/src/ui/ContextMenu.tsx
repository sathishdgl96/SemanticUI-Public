import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";

export interface MenuItem {
  /** Stable across renders; also the test handle. */
  id: string;
  label: string;
  icon?: IconName;
  /** Shown greyed with this as the tooltip, rather than hidden -- an
   *  action that is missing reads as a bug, one that says why does not. */
  disabledReason?: string;
  /** Draws it as the destructive one. */
  danger?: boolean;
  /** A rule above it, to separate a destructive action from the rest. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * A right-click menu, positioned at the pointer.
 *
 * The browser's own menu is suppressed only where one of these opens --
 * never globally. A page-wide `contextmenu` block takes away copy, "open
 * in new tab", spell-check and the inspector, none of which this app has
 * any business withholding; the surfaces below have their own menu to
 * offer instead, which is the only thing that earns the suppression.
 */
export default function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: MenuPosition;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  // Flipped back inside the viewport once its real size is known. Measured
  // in a layout effect so it never paints in the wrong place first.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - box.width - margin)),
      y: Math.max(margin, Math.min(at.y, window.innerHeight - box.height - margin)),
    });
  }, [at]);

  // Anything that is not choosing an item closes it: a click anywhere, a
  // scroll, Escape, or another right-click.
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // The first item takes focus, so the menu is operable from the
    // keyboard the moment it opens -- Shift+F10 and the Menu key raise a
    // contextmenu event exactly as the right button does.
    ref.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{ left: position.x, top: position.y }}
      // Or the document-level listener above would close it on the way in.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <hr className="context-menu-rule" />}
          <button
            type="button"
            role="menuitem"
            data-item={item.id}
            className={item.danger ? "context-menu-item danger" : "context-menu-item"}
            disabled={Boolean(item.disabledReason)}
            title={item.disabledReason}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && <Icon name={item.icon} size={14} />}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Open-menu state plus the handler that opens it.
 *
 *  `preventDefault` lives here rather than in each caller so that
 *  suppressing the browser menu and providing a replacement are the same
 *  act -- one cannot be done without the other by accident. */
export function useContextMenu() {
  const [at, setAt] = useState<MenuPosition | null>(null);
  const open = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAt({ x: event.clientX, y: event.clientY });
  };
  return { at, open, close: () => setAt(null) };
}
