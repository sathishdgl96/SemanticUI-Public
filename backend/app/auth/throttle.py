"""A sliding-window rate limiter for the auth surfaces.

In-process on purpose: auth attempts are the one thing that must be
throttled even when the database is the thing under attack. Keys combine
client address and the claimed identity so an attacker cannot lock out a
user from afar without also revealing an address to block, and a shared
NAT does not lock out a whole office for one person's typos.

The interface is deliberately tiny (allow / register_failure) so a
Redis-backed implementation can replace it for multi-replica deployments
without touching call sites.
"""

import threading
import time
from collections import deque

#: Attempts allowed per window before 429s begin.
LIMIT = 8
WINDOW_SECONDS = 60.0


class SlidingWindow:
    def __init__(self, limit: int = LIMIT, window: float = WINDOW_SECONDS,
                 clock=time.monotonic) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._hits: dict[str, deque] = {}
        #: key -> {fingerprint: first-counted-at}, for register_failure_once.
        self._seen: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque:
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self._window:
            hits.popleft()
        if not hits:
            # Empty deques are dropped so the dict cannot grow without
            # bound under a scan of many identities.
            self._hits.pop(key, None)
            hits = self._hits.setdefault(key, deque())
        return hits

    def allowed(self, key: str) -> bool:
        """True while the key has failure budget left in the window."""
        with self._lock:
            now = self._clock()
            return len(self._prune(key, now)) < self._limit

    def register_failure(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            self._prune(key, now).append(now)

    def register_failure_once(self, key: str, fingerprint: str) -> None:
        """Count a failure once per (key, fingerprint) per window.

        MSOLAP re-sends one rejected connect token in a burst of retries;
        counting every retry would burn the whole per-client budget on a
        single stale credential and 429 the user's FRESH token too. Only
        distinct bad credentials count, so a brute-force scan (many
        fingerprints) still exhausts the budget at the same rate.
        """
        with self._lock:
            now = self._clock()
            seen = self._seen.setdefault(key, {})
            for fp, counted_at in list(seen.items()):
                if now - counted_at > self._window:
                    del seen[fp]
            if not seen:
                self._seen.pop(key, None)
                seen = self._seen.setdefault(key, {})
            if fingerprint in seen:
                return
            seen[fingerprint] = now
            self._prune(key, now).append(now)

    def retry_after(self, key: str) -> int:
        with self._lock:
            now = self._clock()
            hits = self._prune(key, now)
            if len(hits) < self._limit:
                return 0
            return max(1, int(self._window - (now - hits[0])) + 1)


_auth_window: SlidingWindow | None = None


def auth_window() -> SlidingWindow:
    global _auth_window
    if _auth_window is None:
        _auth_window = SlidingWindow()
    return _auth_window


def reset_window() -> None:
    """Test isolation: one test's failures must not 429 the next."""
    global _auth_window
    _auth_window = None
