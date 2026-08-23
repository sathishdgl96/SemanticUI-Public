import { Link } from "react-router-dom";
import type { RecentItem } from "../api/home";
import { recordView } from "../api/library";
import { exactTime, relativeTime } from "../ui/relativeTime";

/** Where an item lives. An explore has no page of its own -- it opens in
 *  the explorer, restored from its saved query. */
function hrefFor(item: RecentItem): string {
  return item.itemType === "report"
    ? `/reports/${item.id}`
    : `/explore?explore=${encodeURIComponent(item.id)}`;
}

/**
 * The last ten things this person opened.
 *
 * Reports and explores interleaved by time rather than split into two
 * lists: "what was I just working on" does not care which kind of thing
 * the answer turns out to be.
 */
export default function RecentItems({ items }: { items: RecentItem[] }) {
  if (items.length === 0) {
    return (
      <p className="tile-hint">
        Nothing opened yet. What you open shows up here.
      </p>
    );
  }

  return (
    <ul className="recent-list">
      {items.map((item) => (
        <li key={`${item.itemType}:${item.id}`}>
          <Link
            className="recent-item"
            to={hrefFor(item)}
            // Recorded on the way out, not on arrival: this list is where
            // "recently opened" is read, and a failed record must never
            // block the navigation.
            onClick={() => {
              void recordView(item.itemType, item.id).catch(() => {});
            }}
          >
            <span className="recent-kind" aria-hidden="true">
              {item.itemType === "report" ? "▦" : "◈"}
            </span>
            <span className="recent-body">
              <span className="recent-name">{item.name}</span>
              <span className="recent-meta">
                {item.workspaceName ? `${item.workspaceName} · ` : ""}
                <span title={exactTime(item.lastViewedAt)}>
                  {relativeTime(item.lastViewedAt)}
                </span>
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
