/** Dates for a column you compare down, rather than one you glance at.
 *
 *  `relativeTime` is right for a Modified column: it drops the year inside
 *  the current year, because "12 Aug" is what you want there. In a table
 *  ranking seven sources by staleness that is actively misleading -- "Jun 2"
 *  beside "Dec 14, 2024" gives no clue they are eighteen months apart, and a
 *  column mixing "2 days ago" with "Sep 2, 2025" cannot be compared at all.
 *
 *  So: one absolute stamp that always carries its year, and one age you can
 *  scan. Both, side by side, beat either alone.
 */

const DAY = 24 * 60 * 60 * 1000;
const EM_DASH = "—";

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date you can line up with the one above it. Always shows the year. */
export function dayStamp(iso: string | null): string {
  const date = parse(iso);
  if (!date) return EM_DASH;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** How far behind a source is, in the largest unit that stays readable.
 *
 *  Days while days are what a reader is judging, then months, then years --
 *  because "20 mo" makes somebody do the division themselves. */
export function ageSince(iso: string | null, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return EM_DASH;

  // A source stamped fractionally ahead of the browser is clock skew, not
  // the future, and must never read "-1 days" in a column about staleness.
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  const days = Math.floor(elapsed / DAY);
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;

  // Calendar months, not days divided by an average one: last September to
  // this August is eleven months to a reader, and 334/30.44 floors to ten.
  let months =
    (now.getFullYear() - date.getFullYear()) * 12 +
    (now.getMonth() - date.getMonth());
  if (now.getDate() < date.getDate()) months -= 1;
  if (months < 12) return `${months} mo`;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`;
}
