import { useState } from "react";
import CloseButton from "../ui/CloseButton";
import Icon from "../ui/Icon";

/** Long enough for a caveat, short enough that it stays a banner rather
 *  than becoming the dashboard. Matches the server's own bound. */
export const ANNOUNCEMENT_MAX = 500;

/**
 * A note from whoever maintains a dashboard, above the tiles.
 *
 * Part of the dashboard rather than a per-user message: "Q3 is
 * provisional until the 5th" is a fact about the numbers, and everyone
 * reading them needs it. So it is not dismissible either -- a caveat you
 * can turn off is a caveat half the readers will not have.
 */
export default function Announcement({
  text,
  canEdit,
  saving,
  onChange,
}: {
  text: string | null;
  canEdit: boolean;
  saving?: boolean;
  onChange: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  if (!text && !canEdit) return null;

  if (editing) {
    return (
      <form
        className="announcement editing"
        aria-label="Edit announcement"
        onSubmit={(event) => {
          event.preventDefault();
          onChange(draft.trim() || null);
          setDraft(null);
        }}
      >
        <label className="sr-only" htmlFor="dashboard-announcement">
          Announcement
        </label>
        <textarea
          id="dashboard-announcement"
          value={draft}
          maxLength={ANNOUNCEMENT_MAX}
          rows={2}
          autoFocus
          placeholder="What should everyone opening this dashboard know?"
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className="announcement-actions">
          <span className="announcement-count">
            {ANNOUNCEMENT_MAX - draft.length}
          </span>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </span>
      </form>
    );
  }

  if (!text) {
    return (
      <button
        type="button"
        className="announcement-add"
        onClick={() => setDraft("")}
      >
        <Icon name="chat" size={14} />
        Add an announcement
      </button>
    );
  }

  return (
    <aside className="announcement" role="note" aria-label="Announcement">
      <Icon name="chat" size={15} />
      <p>{text}</p>
      {canEdit && (
        <span className="announcement-actions">
          <button type="button" className="link" onClick={() => setDraft(text)}>
            Edit
          </button>
          {/* Clearing it is the x, in the place every panel's x is. */}
          <CloseButton label="Remove announcement" onClick={() => onChange(null)} />
        </span>
      )}
    </aside>
  );
}
