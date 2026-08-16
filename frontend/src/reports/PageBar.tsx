import { useState } from "react";
import type { Page } from "../api/types";

interface Props {
  pages: Page[];
  activeId: string;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

/** The tab strip under the canvas. Structural changes are delegated upward --
 *  this component owns only the transient bits (which menu is open, the
 *  in-progress rename), so the definition stays the single source of truth. */
export default function PageBar({
  pages,
  activeId,
  canEdit,
  onSelect,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
  onMove,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const index = pages.findIndex((p) => p.id === activeId);
  const active = pages[index];

  const startRename = () => {
    if (!active) return;
    setDraft(active.name);
    setRenaming(true);
    setRenameError(null);
    setMenuOpen(false);
  };

  const commitRename = () => {
    if (!active) return;
    const name = draft.trim();
    // An empty name is a cancel, not an error: there is nothing to keep, and
    // refusing it would trap the user in an input they cannot leave.
    if (!name || name === active.name) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    if (pages.some((p) => p.id !== active.id && p.name === name)) {
      setRenameError(`A page named "${name}" already exists.`);
      return;
    }
    onRename(active.id, name);
    setRenaming(false);
    setRenameError(null);
  };

  return (
    <div className="page-bar">
      {pages.map((page) => {
        const isActive = page.id === activeId;
        if (isActive && renaming) {
          return (
            <span className="page-rename" key={page.id}>
              <input
                aria-label="Page name"
                autoFocus
                value={draft}
                maxLength={100}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setRenameError(null);
                  }
                }}
                onBlur={commitRename}
              />
              {renameError && <span role="alert">{renameError}</span>}
            </span>
          );
        }
        return (
          <button
            key={page.id}
            type="button"
            className={isActive ? "page-tab active" : "page-tab"}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(page.id)}
            onDoubleClick={() => {
              if (canEdit && isActive) startRename();
            }}
          >
            {page.name}
          </button>
        );
      })}
      {canEdit && (
        <button
          type="button"
          className="page-add"
          aria-label="New page"
          title="New page"
          onClick={onAdd}
        >
          +
        </button>
      )}
      {canEdit && active && (
        <span className="page-actions">
          <button
            type="button"
            className="page-menu-toggle"
            aria-label={`Page actions for ${active.name}`}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirming(false);
            }}
          >
            ⌄
          </button>
          {menuOpen && !confirming && (
            <span className="page-menu" role="group" aria-label="Page actions">
              <button type="button" onClick={startRename}>
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate(active.id);
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => {
                  setMenuOpen(false);
                  onMove(active.id, -1);
                }}
              >
                Move left
              </button>
              <button
                type="button"
                disabled={index >= pages.length - 1}
                onClick={() => {
                  setMenuOpen(false);
                  onMove(active.id, 1);
                }}
              >
                Move right
              </button>
              {/* A report always has at least one page, so the last one cannot
                  be deleted -- disabled with the reason rather than hidden. */}
              <button
                type="button"
                disabled={pages.length <= 1}
                title={
                  pages.length <= 1 ? "A report needs at least one page" : undefined
                }
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            </span>
          )}
          {menuOpen && confirming && (
            <span className="page-menu" role="dialog" aria-label="Confirm delete page">
              <span>Delete "{active.name}"? Its visuals go with it.</span>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirming(false);
                  onDelete(active.id);
                }}
              >
                Delete page
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );
}
