/** How long ago something happened, for a list you scan rather than audit.
 *
 *  "8/20/2026, 10:36:20 AM" in a Modified column is twelve characters of
 *  precision nobody reads and one fact everybody wants. Recent things get
 *  the fact; anything older than a week gets a date, because "37 days ago"
 *  is worse than "12 Aug".
 *
 *  The exact timestamp is not thrown away -- callers put it in the title
 *  attribute, which is where precision belongs.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Same calendar day as `now`, in local time. */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";

  const elapsed = now.getTime() - then.getTime();
  // A clock skew between server and browser must not produce "in 3
  // minutes" in a Modified column.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} min ago`;
  }
  if (elapsed < DAY && sameDay(then, now)) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(then, yesterday)) return "yesterday";

  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;

  // Beyond a week a date reads better than a count. The year is only worth
  // the space when it is not this one.
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The full timestamp, for the title attribute. */
export function exactTime(iso: string): string {
  const then = new Date(iso);
  return Number.isNaN(then.getTime()) ? "" : then.toLocaleString();
}
