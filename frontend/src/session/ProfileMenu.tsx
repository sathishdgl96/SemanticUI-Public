import { useEffect, useRef, useState } from "react";
import { useSessionContext } from "./useSessionContext";

/**
 * Who you are, what you are running as, and how to change it.
 *
 * The current role and warehouse are on the trigger rather than hidden
 * inside the menu: the same report returns different rows under a
 * different role, so "which role am I in" is something you should never
 * have to click to find out.
 */
export function ProfileMenu({
  user,
  account,
  onGettingStarted,
}: {
  user: string;
  account: string;
  /** Reopens the welcome dialog. Lives here rather than as new chrome in the
   *  topbar: orientation is a per-user thing, and this menu is already where
   *  per-user things are. */
  onGettingStarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { context, switchTo } = useSessionContext();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const busy = switchTo.isPending;

  return (
    <div className="profile" ref={container}>
      <button
        type="button"
        className="profile-trigger"
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="profile-identity">
          {user} @ {account}
        </span>
        {context ? (
          <span className="profile-context">
            {context.role ?? "default role"} · {context.warehouse ?? "default warehouse"}
          </span>
        ) : null}
      </button>

      {open && context ? (
        <div className="profile-menu">
          <p className="profile-menu-hint">
            Reports run with this role and warehouse.
          </p>
          <label className="profile-field">
            <span>Role</span>
            <select
              value={context.role ?? ""}
              disabled={busy}
              onChange={(event) => switchTo.mutate({ role: event.target.value })}
            >
              {context.role === null ? <option value="">Default</option> : null}
              {context.roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="profile-field">
            <span>Warehouse</span>
            <select
              value={context.warehouse ?? ""}
              disabled={busy}
              onChange={(event) => switchTo.mutate({ warehouse: event.target.value })}
            >
              {context.warehouse === null ? <option value="">Default</option> : null}
              {context.warehouses.map((warehouse) => (
                <option key={warehouse} value={warehouse}>
                  {warehouse}
                </option>
              ))}
            </select>
          </label>
          {switchTo.isError ? (
            <p className="profile-menu-error" role="alert">
              That is not available to you.
            </p>
          ) : null}
          {onGettingStarted ? (
            <button
              type="button"
              className="link profile-menu-link"
              onClick={() => {
                setOpen(false);
                onGettingStarted();
              }}
            >
              Getting started
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
