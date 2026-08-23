/** One tile's position, as react-grid-layout reports it. */
export interface TileLayout {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Order-independent, so a grid that reports its tiles in a different order
 *  is not mistaken for a rearrangement. */
function fingerprint(layouts: TileLayout[]): string {
  return [...layouts]
    .map((l) => `${l.id}:${l.x},${l.y},${l.w},${l.h}`)
    .sort()
    .join("|");
}

const RETRY_AFTER = 2000;

/**
 * Saves a dashboard arrangement in the background, at most one at a time.
 *
 * react-grid-layout reports a layout change on drag stop, on mount, and
 * again from componentDidUpdate whenever its `layout` prop moves. Firing a
 * request at each of those put several writes of the same document in the
 * air at once, and which one the server committed last was a race the
 * client could not see -- so a drag saved sometimes and not others.
 *
 * Three rules fix that, and they are the whole of this module:
 *
 *   - **Coalesce.** A burst inside `delay` becomes one write of the last
 *     layout. Nobody wants the intermediate positions of a drag.
 *   - **Never overlap.** A change arriving while a write is in flight waits
 *     for it. Two PUTs of one document can only race.
 *   - **Newest wins.** Anything queued behind a write is superseded by
 *     whatever arrives after it, because only the final position matters.
 *
 * A failed write is retried rather than dropped: losing an arrangement
 * silently is the complaint this exists to answer. It stops retrying when
 * something newer arrives, or when the component goes away.
 */
export function createSaveQueue(
  save: (layouts: TileLayout[]) => Promise<unknown>,
  delay = 400,
  /** What the server already holds, so the grid reporting its own layout on
   *  mount is not written straight back as an edit. */
  initial?: TileLayout[],
) {
  let saved = initial ? fingerprint(initial) : null;
  let pending: TileLayout[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let disposed = false;

  function schedule(after: number) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, after);
  }

  function run() {
    timer = null;
    if (disposed || inFlight || pending === null) return;

    const sending = pending;
    const mark = fingerprint(sending);
    pending = null;
    inFlight = true;

    save(sending)
      .then(() => {
        saved = mark;
      })
      .catch(() => {
        // Put it back only if nothing newer has arrived; a later layout is
        // a better thing to send than this one.
        if (pending === null) pending = sending;
      })
      .finally(() => {
        inFlight = false;
        if (disposed || pending === null) return;
        // A queued change goes immediately -- it has already waited out one
        // request. A retry of the same layout waits, so a server that is
        // down is not hammered.
        schedule(fingerprint(pending) === mark ? RETRY_AFTER : 0);
      });
  }

  return {
    /** Record the newest layout. Writes follow on their own. */
    push(layouts: TileLayout[]) {
      if (disposed) return;
      if (fingerprint(layouts) === saved) {
        // Identical to what the server holds: the grid reporting itself on
        // mount, or snapping back to the layout it was given.
        pending = null;
        return;
      }
      pending = layouts;
      if (!inFlight) schedule(delay);
    },
    /** Stop. Anything not yet sent is abandoned. */
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
